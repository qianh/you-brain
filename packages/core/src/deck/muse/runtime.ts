import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  MAIN_MUSE_SESSION_ID,
  MuseChatStore,
  compactImages,
  previewOf,
  type StoredMuseSession,
} from "./store.js";
import {
  MuseClient,
  MuseError,
  MuseTurn,
  ReplayScope,
  acknowledgementIds,
  cleanControlChars,
  externalCredentialsDirectory,
  hasPairingFiles,
  importExternalPairing,
  loadCredentials,
  pairMacOS,
  saveCredentials,
  transcriptText,
  unpair,
  validateMessage,
  type ChatEvent,
  type ConnectOptions,
  type DeviceCredentials,
  type ImageAttachment,
  type MuseHistoryItem,
  type PairMacOSOptions,
  type TurnEvent,
} from "./sdk/index.js";
import type {
  DeckMuseActionInput,
  DeckMuseActionResult,
  DeckMuseImageView,
  DeckMuseMessage,
  DeckMuseOverview,
  DeckMusePairingView,
  DeckMuseSendInput,
  DeckMuseSendResult,
  DeckMuseSessionDetail,
  DeckMuseSessionSummary,
  DeckMuseStreamEvent,
  DeckMuseVmView,
  MuseConnectionState,
} from "./types.js";

export interface MuseClientLike {
  readonly closed: boolean;
  readonly vm: { id: string; name: string; url: string; isDefault: boolean };
  readonly vms: ReadonlyArray<{ id: string; name: string; url: string; isDefault: boolean }>;
  onDisconnect(listener: (error: Error) => void): () => void;
  sendMessage: MuseClient["sendMessage"];
  subscribe: MuseClient["subscribe"];
  chat: MuseClient["chat"];
  fetchHistory?: ((limit?: number) => Promise<MuseHistoryItem[]>) | undefined;
  close(): void;
}

export interface MuseDeckRuntimeOptions {
  dataDir: string;
  homeDir: string;
  platform?: NodeJS.Platform | undefined;
  now?: (() => Date) | undefined;
  connectClient?: ((options: ConnectOptions) => Promise<MuseClientLike>) | undefined;
  pairImpl?: ((options: PairMacOSOptions) => Promise<DeviceCredentials | undefined>) | undefined;
  externalDir?: string | undefined;
}

interface ActiveTurnState {
  controller: AbortController;
  activityText?: string | undefined;
  error?: string | undefined;
}

const STREAM_THROTTLE_MS = 60;
const FIRST_SIDE_TURN_TIMEOUT_MS = 180_000;

export class MuseDeckRuntime {
  readonly #museDir: string;
  readonly #externalDir: string;
  readonly #homeDir: string;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => Date;
  readonly #store: MuseChatStore;
  readonly #connectImpl: (options: ConnectOptions) => Promise<MuseClientLike>;
  readonly #pairImpl: (options: PairMacOSOptions) => Promise<DeviceCredentials | undefined>;

  #stopped = false;
  #client: MuseClientLike | null = null;
  #connecting: Promise<MuseClientLike> | null = null;
  #connectionState: MuseConnectionState = "idle";
  #connectionError: string | null = null;
  #warning: string | null = null;
  #vm: { id: string; name: string } | null = null;
  #vms: DeckMuseVmView[] = [];

  #pairingState: DeckMusePairingView = { state: "idle" };
  #pairingAbort: AbortController | null = null;

  #mainSubAbort: AbortController | null = null;
  #historySyncPromise: Promise<void> | null = null;
  readonly #mainReplayScope = new ReplayScope();
  readonly #localUserIds = new Set<string>();
  #sendingMainCount = 0;
  #pendingRemoteUsers: Array<{ id: string; text: string; createdAt: string }> = [];
  readonly #sideReplayScopes = new Map<string, ReplayScope>();
  readonly #activeTurns = new Map<string, ActiveTurnState>();
  readonly #sessionErrors = new Map<string, string>();

  readonly #listeners = new Set<(event: DeckMuseStreamEvent) => void>();
  readonly #sessionPushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: MuseDeckRuntimeOptions) {
    this.#museDir = join(options.dataDir, "deck", "muse");
    this.#homeDir = options.homeDir;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => new Date());
    this.#externalDir =
      options.externalDir ?? externalCredentialsDirectory(this.#homeDir, this.#platform);
    this.#store = new MuseChatStore(join(this.#museDir, "chats.json"), this.#now);
    this.#connectImpl = options.connectClient ?? ((opts) => MuseClient.connect(opts));
    this.#pairImpl = options.pairImpl ?? ((opts) => pairMacOS(opts));
  }

  stop(): void {
    this.#stopped = true;
    this.#pairingAbort?.abort();
    this.#pairingAbort = null;
    for (const active of this.#activeTurns.values()) active.controller.abort();
    this.#activeTurns.clear();
    for (const timer of this.#sessionPushTimers.values()) clearTimeout(timer);
    this.#sessionPushTimers.clear();
    this.#disconnectClient();
    this.#listeners.clear();
  }

  subscribeStream(listener: (event: DeckMuseStreamEvent) => void): () => void {
    this.#listeners.add(listener);
    // Warm the connection lazily when a UI listener attaches and credentials exist.
    void this.#warmIfPaired();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async #warmIfPaired(): Promise<void> {
    if (this.#stopped || this.#client || this.#connecting) return;
    if (!(await hasPairingFiles(this.#museDir))) return;
    await this.#ensureConnected().catch(() => undefined);
  }

  #emit(event: DeckMuseStreamEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Ignore individual consumer failures.
      }
    }
  }

  async #emitOverview(): Promise<DeckMuseOverview> {
    const view = await this.overview({ autoConnect: false });
    this.#emit({ type: "overview", overview: view });
    return view;
  }

  #scheduleSessionEmit(sessionId: string, immediate = false): void {
    const existing = this.#sessionPushTimers.get(sessionId);
    if (immediate) {
      if (existing !== undefined) {
        clearTimeout(existing);
        this.#sessionPushTimers.delete(sessionId);
      }
      void this.#pushSessionNow(sessionId);
      return;
    }
    if (existing !== undefined) return;
    const timer = setTimeout(() => {
      this.#sessionPushTimers.delete(sessionId);
      void this.#pushSessionNow(sessionId);
    }, STREAM_THROTTLE_MS);
    timer.unref?.();
    this.#sessionPushTimers.set(sessionId, timer);
  }

  async #pushSessionNow(sessionId: string): Promise<void> {
    const detail = await this.session(sessionId);
    if (detail) this.#emit({ type: "session", session: detail });
  }

  async overview(options: { autoConnect?: boolean } = {}): Promise<DeckMuseOverview> {
    const paired = await hasPairingFiles(this.#museDir);
    const hasExternal = !paired && (await hasPairingFiles(this.#externalDir));
    let deviceId: string | null = null;
    let sdkTokenHint: string | null = null;
    if (paired) {
      try {
        const creds = await loadCredentials(this.#museDir);
        deviceId = creds.deviceId;
        sdkTokenHint = creds.sdkTokenHint ?? (creds.sdkToken ? creds.sdkToken.slice(0, 12) : null);
      } catch (error) {
        this.#connectionState = "error";
        this.#connectionError = error instanceof Error ? error.message : String(error);
      }
      if (options.autoConnect !== false && !this.#client && !this.#connecting && this.#connectionState === "idle") {
        void this.#ensureConnected().catch(() => undefined);
      }
    } else {
      this.#connectionState = "unpaired";
      this.#connectionError = null;
      this.#vm = null;
      this.#vms = [];
    }

    const selectedVmId = await this.#store.selectedVmId();
    const sessions = await this.#store.listSessions();
    return {
      paired,
      platformSupported: this.#platform === "darwin",
      hasExternalPairing: hasExternal,
      deviceId,
      sdkTokenHint,
      warning: this.#warning,
      connection: paired ? this.#connectionState : "unpaired",
      connectionError: paired ? this.#connectionError : null,
      selectedVmId,
      vm: this.#vm,
      vms: [...this.#vms],
      pairing: { ...this.#pairingState },
      sessions: sessions.map((s) => this.#toSummary(s)),
    };
  }

  async session(id = MAIN_MUSE_SESSION_ID): Promise<DeckMuseSessionDetail | null> {
    const targetId = id.trim() || MAIN_MUSE_SESSION_ID;
    const stored = await this.#store.getSession(targetId);
    if (!stored) return null;
    return this.#toDetail(stored);
  }

  #toSummary(session: StoredMuseSession): DeckMuseSessionSummary {
    const active = this.#activeTurns.get(session.id);
    return {
      id: session.id,
      kind: session.kind,
      title: session.title,
      updatedAt: session.updatedAt,
      preview: previewOf(session.messages),
      messageCount: session.messages.length,
      busy: active !== undefined,
      ...(active?.activityText ? { activityText: active.activityText } : {}),
    };
  }

  #toDetail(session: StoredMuseSession): DeckMuseSessionDetail {
    const active = this.#activeTurns.get(session.id);
    const err = active?.error ?? this.#sessionErrors.get(session.id);
    return {
      id: session.id,
      kind: session.kind,
      title: session.title,
      updatedAt: session.updatedAt,
      busy: active !== undefined,
      ...(active?.activityText ? { activityText: active.activityText } : {}),
      ...(err ? { error: err } : {}),
      messages: session.messages,
    };
  }

  async action(input: DeckMuseActionInput): Promise<DeckMuseActionResult> {
    switch (input.action) {
      case "pair-start": {
        this.#startPairing(input.sdkToken, input.probe === true);
        return { overview: await this.#emitOverview() };
      }
      case "pair-cancel": {
        this.#pairingAbort?.abort();
        this.#pairingAbort = null;
        this.#pairingState = { state: "idle" };
        return { overview: await this.#emitOverview() };
      }
      case "pair-import": {
        if (this.#pairingAbort) throw new MuseError("正在进行蓝牙配对，请先取消");
        if (!(await hasPairingFiles(this.#externalDir))) {
          throw new MuseError("未找到可导入的本机 Muse 配对凭据");
        }
        await importExternalPairing(this.#externalDir, this.#museDir);
        this.#pairingState = { state: "idle" };
        this.#connectionState = "idle";
        this.#connectionError = null;
        await this.#ensureConnected().catch(() => undefined);
        await this.#historySyncPromise;
        return { overview: await this.#emitOverview() };
      }
      case "unpair": {
        this.#pairingAbort?.abort();
        this.#pairingAbort = null;
        for (const active of this.#activeTurns.values()) active.controller.abort();
        this.#activeTurns.clear();
        this.#disconnectClient();
        await unpair(this.#museDir);
        this.#pairingState = { state: "idle" };
        this.#connectionState = "unpaired";
        this.#connectionError = null;
        this.#warning = null;
        this.#vm = null;
        this.#vms = [];
        return { overview: await this.#emitOverview() };
      }
      case "reconnect": {
        this.#disconnectClient();
        this.#connectionState = "idle";
        this.#connectionError = null;
        await this.#ensureConnected();
        await this.#historySyncPromise;
        return { overview: await this.#emitOverview() };
      }
      case "select-vm": {
        await this.#store.setSelectedVmId(input.vmId);
        this.#disconnectClient();
        this.#connectionState = "idle";
        this.#connectionError = null;
        if (await hasPairingFiles(this.#museDir)) {
          await this.#ensureConnected();
        }
        return { overview: await this.#emitOverview() };
      }
      case "session-create": {
        const created = await this.#store.createSideSession(input.title);
        const overview = await this.#emitOverview();
        return {
          overview,
          createdSessionId: created.id,
          session: this.#toDetail(created),
        };
      }
      case "session-rename": {
        const updated = await this.#store.renameSession(input.id, input.title);
        const overview = await this.#emitOverview();
        const detail = this.#toDetail(updated);
        this.#emit({ type: "session", session: detail });
        return { overview, session: detail };
      }
      case "session-delete": {
        this.#activeTurns.get(input.id)?.controller.abort();
        this.#activeTurns.delete(input.id);
        this.#sessionErrors.delete(input.id);
        this.#sideReplayScopes.delete(input.id);
        await this.#store.deleteOrClearSession(input.id);
        const overview = await this.#emitOverview();
        if (input.id === MAIN_MUSE_SESSION_ID) {
          const mainDetail = await this.session(MAIN_MUSE_SESSION_ID);
          if (mainDetail) this.#emit({ type: "session", session: mainDetail });
        }
        return { overview };
      }
      case "turn-cancel": {
        const running = this.#activeTurns.get(input.sessionId);
        if (running) {
          running.controller.abort(new MuseError("已停止等待回复"));
          this.#activeTurns.delete(input.sessionId);
        }
        const overview = await this.#emitOverview();
        const detail = await this.session(input.sessionId);
        if (detail) this.#emit({ type: "session", session: detail });
        return { overview, ...(detail ? { session: detail } : {}) };
      }
    }
  }

  #startPairing(sdkToken: string | undefined, probe: boolean): void {
    if (this.#pairingAbort) return;
    const abort = new AbortController();
    this.#pairingAbort = abort;
    this.#pairingState = {
      state: "compiling",
      message: "正在准备蓝牙配对环境…",
    };
    void (async () => {
      try {
        const creds = await this.#pairImpl({
          directory: this.#museDir,
          sdkToken,
          probe,
          signal: abort.signal,
          homeDir: this.#homeDir,
          onProgress: (ev) => {
            if (this.#pairingAbort !== abort) return;
            this.#pairingState = {
              state: ev.phase,
              ...(ev.deviceName ? { deviceName: ev.deviceName } : {}),
              message: ev.message,
            };
            void this.#emitOverview();
          },
        });
        if (this.#pairingAbort !== abort) return;
        this.#pairingAbort = null;
        if (probe) {
          this.#pairingState = {
            state: "idle",
            message: "蓝牙发现测试成功：手机已可识别本机，可填入 SDK Token 正式配对。",
          };
          await this.#emitOverview();
          return;
        }
        if (creds) {
          this.#pairingState = { state: "idle" };
          this.#connectionState = "idle";
          this.#connectionError = null;
          await this.#ensureConnected().catch(() => undefined);
          await this.#emitOverview();
        }
      } catch (error) {
        if (this.#pairingAbort !== abort) return;
        this.#pairingAbort = null;
        if (abort.signal.aborted) {
          this.#pairingState = { state: "idle" };
        } else {
          this.#pairingState = {
            state: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        await this.#emitOverview();
      }
    })();
  }

  #disconnectClient(): void {
    this.#mainSubAbort?.abort();
    this.#mainSubAbort = null;
    const current = this.#client;
    this.#client = null;
    this.#connecting = null;
    if (current) {
      try {
        current.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  async #ensureConnected(): Promise<MuseClientLike> {
    if (this.#client && !this.#client.closed) return this.#client;
    if (this.#connecting) return this.#connecting;
    if (!(await hasPairingFiles(this.#museDir))) {
      this.#connectionState = "unpaired";
      throw new MuseError("尚未配对 Muse，请先完成蓝牙配对。");
    }

    this.#connectionState = "connecting";
    this.#connectionError = null;
    void this.#emitOverview();

    const task = (async (): Promise<MuseClientLike> => {
      const credentials = await loadCredentials(this.#museDir);
      const selectedVmId = await this.#store.selectedVmId();
      this.#warning = null;
      const client = await this.#connectImpl({
        credentials,
        ...(selectedVmId ? { vmId: selectedVmId } : {}),
        onCredentials: async (next) => {
          await saveCredentials(next, this.#museDir);
        },
        onWarning: (msg) => {
          this.#warning = msg;
        },
      });
      if (this.#stopped) {
        client.close();
        throw new MuseError("服务已停止");
      }
      this.#client = client;
      this.#connectionState = "connected";
      this.#connectionError = null;
      this.#vm = { id: client.vm.id, name: client.vm.name };
      this.#vms = client.vms.map((v) => ({ id: v.id, name: v.name, isDefault: v.isDefault }));

      client.onDisconnect((err) => {
        if (this.#client !== client) return;
        this.#client = null;
        this.#mainSubAbort?.abort();
        this.#mainSubAbort = null;
        if (!this.#stopped) {
          this.#connectionState = "idle";
          this.#connectionError = err.message;
          void this.#emitOverview();
        }
      });

      this.#startMainSubscription(client);
      const historyTask = this.#syncMainHistory(client);
      this.#historySyncPromise = historyTask.finally(() => {
        if (this.#historySyncPromise === historyTask) this.#historySyncPromise = null;
      });
      void this.#emitOverview();
      return client;
    })();

    this.#connecting = task;
    try {
      return await task;
    } catch (error) {
      this.#connectionState = "error";
      this.#connectionError = error instanceof Error ? error.message : String(error);
      void this.#emitOverview();
      throw error;
    } finally {
      if (this.#connecting === task) this.#connecting = null;
    }
  }

  /**
   * Background subscription on the user's Main Muse Chat:
   * captures messages typed on the user's phone/desktop Muse App (`message.user`)
   * as well as assistant replies initiated outside U-Brain!
   */
  #startMainSubscription(client: MuseClientLike): void {
    this.#mainSubAbort?.abort();
    const controller = new AbortController();
    this.#mainSubAbort = controller;

    void (async () => {
      try {
        const sub = await client.subscribe({ signal: controller.signal });
        const streamingText = new Map<string, string>();
        for await (const event of sub) {
          if (controller.signal.aborted || this.#stopped) break;
          await this.#handleMainBackgroundEvent(event, streamingText);
        }
      } catch {
        // Reconnection happens automatically on next activity or overview warm.
      }
    })();
  }

  #rememberLocalUserId(id: string): void {
    this.#localUserIds.add(id);
    if (this.#localUserIds.size > 512) {
      const oldest = this.#localUserIds.values().next().value;
      if (oldest !== undefined) this.#localUserIds.delete(oldest);
    }
  }

  async #flushPendingRemoteUsers(): Promise<void> {
    if (this.#sendingMainCount > 0 || this.#pendingRemoteUsers.length === 0) return;
    const pending = this.#pendingRemoteUsers;
    this.#pendingRemoteUsers = [];
    let added = false;
    for (const item of pending) {
      if (this.#localUserIds.has(item.id)) continue;
      this.#rememberLocalUserId(item.id);
      await this.#store.upsertMessage(MAIN_MUSE_SESSION_ID, {
        id: `msg:${item.id}`,
        role: "user",
        text: item.text,
        createdAt: item.createdAt,
        done: true,
        origin: "app",
      });
      added = true;
    }
    if (added) {
      this.#scheduleSessionEmit(MAIN_MUSE_SESSION_ID, true);
      void this.#emitOverview();
    }
  }

  async #syncMainHistory(client: MuseClientLike): Promise<void> {
    if (!client.fetchHistory) return;
    try {
      const items = await client.fetchHistory(40);
      if (this.#stopped || items.length === 0) return;
      const mapped: DeckMuseMessage[] = items.map((item) => {
        this.#mainReplayScope.retire([`message:${item.messageId}`]);
        if (item.role === "user") this.#rememberLocalUserId(item.messageId);
        return {
          id: `msg:${item.messageId}`,
          role: item.role,
          text: item.text,
          createdAt: new Date(item.occurredAtMs).toISOString(),
          done: true,
          origin: "app" as const,
        };
      });
      const changed = await this.#store.mergeMainHistory(mapped);
      if (changed && !this.#stopped) {
        this.#scheduleSessionEmit(MAIN_MUSE_SESSION_ID, true);
        await this.#emitOverview();
      }
    } catch {
      // Best-effort history sync; live stream continues regardless.
    }
  }

  async #handleMainBackgroundEvent(event: ChatEvent, streamingText: Map<string, string>): Promise<void> {
    const p = event.payload;
    // Main Chat events carry the user's Main Chat UUID in `session_id` with `is_thread: false`.
    // Only skip side-thread events (`is_thread === true`).
    if (p.is_thread === true) {
      return;
    }
    if (typeof p.visibility === "string" && p.visibility !== "public") {
      return;
    }

    if (event.event === "message.user" && p.role !== "assistant" && p.display_text_ready !== false) {
      const id = typeof p.message_id === "string" ? p.message_id : typeof p.id === "string" ? p.id : "";
      if (!id || this.#localUserIds.has(id)) return;
      this.#mainReplayScope.retire([`message:${id}`]);
      const rawText =
        typeof p.display_text === "string"
          ? p.display_text
          : typeof p.content === "string"
            ? p.content
            : typeof p.text === "string"
              ? p.text
              : "";
      const text = cleanControlChars(rawText).trim();
      if (!text) return;
      if (this.#sendingMainCount > 0) {
        if (this.#pendingRemoteUsers.length < 64) {
          this.#pendingRemoteUsers.push({ id, text, createdAt: this.#now().toISOString() });
        }
        return;
      }
      this.#rememberLocalUserId(id);
      await this.#store.upsertMessage(MAIN_MUSE_SESSION_ID, {
        id: `msg:${id}`,
        role: "user",
        text,
        createdAt: this.#now().toISOString(),
        done: true,
        origin: "app",
      });
      this.#scheduleSessionEmit(MAIN_MUSE_SESSION_ID, true);
      void this.#emitOverview();
      return;
    }

    if (
      event.event === "delta.text_append" ||
      event.event === "delta.message_done" ||
      event.event === "message.assistant"
    ) {
      if (p.role === "user") return;
      const id =
        typeof p.message_id === "string"
          ? p.message_id
          : typeof event.raw.message_id === "string"
            ? event.raw.message_id
            : typeof p.id === "string"
              ? p.id
              : "";
      if (!id) return;
      let text = streamingText.get(id) ?? "";
      let done = false;
      if (event.event === "delta.text_append" && typeof p.text === "string") {
        text += cleanControlChars(p.text);
        streamingText.set(id, text);
      } else {
        let finalText: unknown = p.display_text;
        if (typeof finalText !== "string") {
          finalText = transcriptText(p.transcript, id);
          if (!finalText && typeof p.transcript !== "string") finalText = p.content;
        }
        if (typeof finalText === "string") text = cleanControlChars(finalText);
        if (event.event === "delta.message_done" || p.display_text_ready !== false) {
          done = true;
          streamingText.delete(id);
        } else {
          streamingText.set(id, text);
        }
      }
      if (streamingText.size > 64) {
        const first = streamingText.keys().next().value;
        if (first !== undefined) streamingText.delete(first);
      }
      if (!text && !done) return;
      if (!this.#activeTurns.has(MAIN_MUSE_SESSION_ID) && done) {
        this.#mainReplayScope.retire([`message:${id}`]);
      }
      await this.#store.upsertMessage(
        MAIN_MUSE_SESSION_ID,
        {
          id: `msg:${id}`,
          role: "assistant",
          text,
          createdAt: this.#now().toISOString(),
          done,
          ...(this.#activeTurns.has(MAIN_MUSE_SESSION_ID) ? { origin: "local" as const } : { origin: "app" as const }),
        },
        { persist: done },
      );
      this.#scheduleSessionEmit(MAIN_MUSE_SESSION_ID, done);
      if (done) void this.#emitOverview();
    }
  }

  async send(input: DeckMuseSendInput): Promise<DeckMuseSendResult> {
    const targetId = input.sessionId.trim() || MAIN_MUSE_SESSION_ID;
    const session = await this.#store.getSession(targetId);
    if (!session) throw new MuseError("找不到该 Muse 会话");
    if (this.#activeTurns.has(targetId)) {
      throw new MuseError("当前会话正在等待 Muse 回复，请等待完成或先点击停止");
    }

    const attachments: ImageAttachment[] = (input.images ?? []).map((img) => ({
      filename: img.filename,
      mimeType: img.mimeType,
      data: new Uint8Array(Buffer.from(img.dataBase64, "base64")),
    }));
    validateMessage(input.text, attachments);

    const previewImages: DeckMuseImageView[] | undefined = compactImages(
      (input.images ?? []).map((img) => ({
        filename: img.filename,
        mimeType: img.mimeType,
        dataUrl: `data:${img.mimeType};base64,${img.dataBase64}`,
      })),
    );

    const localMessageId = `local:${randomUUID()}`;
    const userMessage: DeckMuseMessage = {
      id: localMessageId,
      role: "user",
      text: input.text.trim(),
      createdAt: this.#now().toISOString(),
      done: true,
      origin: "local",
      ...(previewImages ? { images: previewImages } : {}),
    };

    this.#sessionErrors.delete(targetId);
    const controller = new AbortController();
    this.#activeTurns.set(targetId, { controller });
    await this.#store.upsertMessage(targetId, userMessage);

    // Kick off the streaming turn asynchronously so the HTTP send returns immediately with optimistic UI state.
    void this.#executeTurn({
      sessionId: targetId,
      isMain: session.kind === "main",
      initializedOnServer: session.initializedOnServer,
      localUserMessageId: localMessageId,
      userMessage,
      text: input.text,
      attachments,
      controller,
    });

    const overview = await this.#emitOverview();
    const detail = (await this.session(targetId))!;
    this.#emit({ type: "session", session: detail });
    return { overview, session: detail };
  }

  async #executeTurn(params: {
    sessionId: string;
    isMain: boolean;
    initializedOnServer: boolean;
    localUserMessageId: string;
    userMessage: DeckMuseMessage;
    text: string;
    attachments: ImageAttachment[];
    controller: AbortController;
  }): Promise<void> {
    const { sessionId, isMain, localUserMessageId, userMessage, text, attachments, controller } = params;
    try {
      const client = await this.#ensureConnected();
      if (isMain) {
        await this.#runMainTurn(client, localUserMessageId, userMessage, text, attachments, controller);
      } else if (!params.initializedOnServer) {
        await this.#runFirstSideTurn(client, sessionId, localUserMessageId, userMessage, text, attachments, controller);
      } else {
        await this.#runOwnedSideTurn(client, sessionId, text, attachments, controller);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.#sessionErrors.set(sessionId, message);
      }
    } finally {
      if (this.#activeTurns.get(sessionId)?.controller === controller) {
        this.#activeTurns.delete(sessionId);
      }
      await this.#store.flush();
      this.#scheduleSessionEmit(sessionId, true);
      await this.#emitOverview();
    }
  }

  async #applyTurnEvent(sessionId: string, event: TurnEvent, controller: AbortController): Promise<void> {
    const active = this.#activeTurns.get(sessionId);
    if (!active || active.controller !== controller) return;
    if (event.type === "agent-status") {
      active.activityText = event.activityText || event.activityCode;
      this.#scheduleSessionEmit(sessionId, false);
      return;
    }
    if (event.type === "task-finished") {
      active.activityText = undefined;
      return;
    }
    if (event.type === "reply") {
      if (event.text || event.done) {
        await this.#store.upsertMessage(
          sessionId,
          {
            id: `msg:${event.messageId}`,
            role: "assistant",
            text: event.text,
            createdAt: this.#now().toISOString(),
            done: event.done,
            origin: "local",
          },
          { persist: event.done },
        );
        this.#scheduleSessionEmit(sessionId, event.done);
      }
    }
  }

  async #runMainTurn(
    client: MuseClientLike,
    localUserMessageId: string,
    userMessage: DeckMuseMessage,
    text: string,
    attachments: ImageAttachment[],
    controller: AbortController,
  ): Promise<void> {
    const turn = new MuseTurn({ replayScope: this.#mainReplayScope });
    const timer = setTimeout(() => controller.abort(new MuseError("等待 Muse 回复超时")), FIRST_SIDE_TURN_TIMEOUT_MS);
    let sub: Awaited<ReturnType<MuseClientLike["subscribe"]>> | undefined;
    let iterator: AsyncIterator<ChatEvent> | undefined;
    this.#sendingMainCount++;
    let sendDecided = false;
    try {
      sub = await client.subscribe({ signal: controller.signal });
      iterator = sub[Symbol.asyncIterator]();
      let next = iterator.next().then((value) => ({ kind: "event" as const, value }));
      void next.catch(() => {});
      const ackPromise = client
        .sendMessage(text, { ...(attachments.length ? { images: attachments } : {}), signal: controller.signal })
        .then(async (ack) => {
          for (const id of acknowledgementIds(ack)) this.#rememberLocalUserId(id);
          await this.#store.upsertMessage(
            MAIN_MUSE_SESSION_ID,
            { ...userMessage, id: `msg:${ack.messageId}` },
            { replaceId: localUserMessageId },
          );
          if (!sendDecided) {
            sendDecided = true;
            this.#sendingMainCount = Math.max(0, this.#sendingMainCount - 1);
            await this.#flushPendingRemoteUsers();
          }
          return { kind: "ack" as const, value: ack };
        });
      void ackPromise.catch(() => {});

      for (;;) {
        const pending = turn.acknowledged ? next : Promise.race([next, ackPromise]);
        const result = await raceDelay(pending, turn.completionDelay(), controller.signal);
        if (result === undefined) return;
        let updates: TurnEvent[];
        if (result.kind === "ack") {
          updates = turn.acknowledge(result.value);
        } else {
          if (result.value.done) {
            if (turn.complete()) return;
            throw new MuseError("Muse 订阅流在回复完成前关闭");
          }
          updates = turn.feed(result.value.value);
          next = iterator.next().then((value) => ({ kind: "event" as const, value }));
          void next.catch(() => {});
        }
        for (const u of updates) {
          await this.#applyTurnEvent(MAIN_MUSE_SESSION_ID, u, controller);
        }
        if (turn.complete()) return;
      }
    } finally {
      clearTimeout(timer);
      if (!sendDecided) {
        this.#sendingMainCount = Math.max(0, this.#sendingMainCount - 1);
        await this.#flushPendingRemoteUsers();
      }
      sub?.close();
      try {
        await iterator?.return?.();
      } finally {
        turn.retire();
      }
    }
  }

  /**
   * First message in a brand-new Side Chat:
   * Muse returns HTTP 404 on `/chat/subscribe` if the `sessionId` does not exist yet,
   * so we MUST create the thread with `sendMessage` first, then subscribe and track replies.
   */
  async #runFirstSideTurn(
    client: MuseClientLike,
    sessionId: string,
    localUserMessageId: string,
    userMessage: DeckMuseMessage,
    text: string,
    attachments: ImageAttachment[],
    controller: AbortController,
  ): Promise<void> {
    const scope = this.#replayScopeFor(sessionId);
    const turn = new MuseTurn({ sessionId, ownsChat: true, replayScope: scope });
    const timer = setTimeout(() => controller.abort(new MuseError("等待 Muse 回复超时")), FIRST_SIDE_TURN_TIMEOUT_MS);
    let sub: Awaited<ReturnType<MuseClientLike["subscribe"]>> | undefined;
    let iterator: AsyncIterator<ChatEvent> | undefined;
    try {
      const ack = await client.sendMessage(text, {
        sessionId,
        ...(attachments.length ? { images: attachments } : {}),
        signal: controller.signal,
      });
      await this.#store.markInitializedOnServer(sessionId);
      await this.#store.upsertMessage(
        sessionId,
        { ...userMessage, id: `msg:${ack.messageId}` },
        { replaceId: localUserMessageId },
      );

      for (const u of turn.acknowledge(ack)) {
        await this.#applyTurnEvent(sessionId, u, controller);
      }
      sub = await client.subscribe({ sessionId, signal: controller.signal });
      iterator = sub[Symbol.asyncIterator]();
      let next = iterator.next();
      void next.catch(() => {});
      for (;;) {
        const item = await raceDelay(next, turn.completionDelay(), controller.signal);
        if (item === undefined) return;
        if (item.done) {
          if (turn.complete()) return;
          throw new MuseError("Muse 子会话订阅在回复完成前关闭");
        }
        for (const u of turn.feed(item.value)) {
          await this.#applyTurnEvent(sessionId, u, controller);
        }
        if (turn.complete()) return;
        next = iterator.next();
        void next.catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      sub?.close();
      try {
        await iterator?.return?.();
      } finally {
        turn.retire();
      }
    }
  }

  async #runOwnedSideTurn(
    client: MuseClientLike,
    sessionId: string,
    text: string,
    attachments: ImageAttachment[],
    controller: AbortController,
  ): Promise<void> {
    const scope = this.#replayScopeFor(sessionId);
    for await (const event of client.chat(text, {
      sessionId,
      ownsChat: true,
      replayScope: scope,
      ...(attachments.length ? { images: attachments } : {}),
      signal: controller.signal,
    })) {
      await this.#applyTurnEvent(sessionId, event, controller);
    }
  }

  #replayScopeFor(sessionId: string): ReplayScope {
    let scope = this.#sideReplayScopes.get(sessionId);
    if (!scope) {
      scope = new ReplayScope();
      this.#sideReplayScopes.set(sessionId, scope);
    }
    return scope;
  }
}

async function raceDelay<T>(pending: Promise<T>, ms: number, signal: AbortSignal): Promise<T | undefined> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve, reject) => {
        if (Number.isFinite(ms)) timer = setTimeout(() => resolve(undefined), ms);
        onAbort = () => reject(signal.reason ?? new MuseError("已取消"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
