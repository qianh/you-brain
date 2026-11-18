// Adapted from Meta's muse-gadget-sdk and wong2/muse-client (Apache-2.0).
import { MuseAccount, object, requiredString, type AccountOptions, type MuseVM } from "./api.js";
import { NoiseConnection, NoiseUpgradeError, type MuseSocketFactory } from "./connection.js";
import { MuseError, MuseHttpError, MuseProtocolError } from "./errors.js";
import { decodeChatEvents, type ChatEvent } from "./events.js";
import { chatRequest, validateMessage, type MessageOptions } from "./message.js";
import {
  MuseTurn,
  ReplayScope,
  cleanControlChars,
  transcriptText,
  type ChatAcknowledgement,
  type TurnEvent,
  type TurnOptions,
} from "./turn.js";

export interface MuseHistoryItem {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  occurredAtMs: number;
}

export interface ConnectOptions extends AccountOptions {
  vmId?: string | undefined;
  createSocket?: MuseSocketFactory | undefined;
}

export interface SendOptions extends MessageOptions {
  signal?: AbortSignal | undefined;
}

export interface SubscribeOptions {
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface ChatOptions extends TurnOptions, SendOptions {
  timeoutMs?: number | undefined;
}

async function until<T>(pending: Promise<T>, ms: number, signal: AbortSignal): Promise<T | undefined> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<undefined>((resolve, reject) => {
        if (Number.isFinite(ms)) timer = setTimeout(() => resolve(undefined), ms);
        aborted = () => reject(signal.reason);
        signal.addEventListener("abort", aborted, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (aborted) signal.removeEventListener("abort", aborted);
  }
}

export async function* followTurn(
  client: Pick<MuseClient, "subscribe" | "sendMessage">,
  message: string,
  options: ChatOptions = {},
): AsyncGenerator<TurnEvent> {
  validateMessage(message, options.images);
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new MuseError("超时时间不合法");
  }
  const turn = new MuseTurn(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MuseError("等待 Muse 回复超时")), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let events: Awaited<ReturnType<MuseClient["subscribe"]>> | undefined;
  let iterator: AsyncIterator<ChatEvent> | undefined;
  try {
    signal.throwIfAborted();
    events = await client.subscribe({ sessionId: options.sessionId, signal });
    iterator = events[Symbol.asyncIterator]();
    let next = iterator.next().then((value) => ({ kind: "event" as const, value }));
    void next.catch(() => {});
    const ack = client
      .sendMessage(message, { sessionId: options.sessionId, images: options.images, signal })
      .then((value) => ({ kind: "ack" as const, value }));
    void ack.catch(() => {});
    for (;;) {
      const pending = turn.acknowledged ? next : Promise.race([next, ack]);
      const result = await until(pending, turn.completionDelay(), signal);
      if (result === undefined) return;
      let updates: TurnEvent[];
      if (result.kind === "ack") {
        updates = turn.acknowledge(result.value);
      } else {
        if (result.value.done) {
          if (turn.complete()) return;
          throw new MuseError("Muse 订阅流在回复完成前中断");
        }
        updates = turn.feed(result.value.value);
        next = iterator.next().then((value) => ({ kind: "event" as const, value }));
        void next.catch(() => {});
      }
      for (const update of updates) {
        yield update;
        signal.throwIfAborted();
      }
      if (turn.complete()) return;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    events?.close();
    try {
      await iterator?.return?.();
    } finally {
      turn.retire();
    }
  }
}

export class MuseClient {
  readonly #replayScope = new ReplayScope();
  readonly #ownedChats = new Set<string>();

  private constructor(
    private readonly connection: NoiseConnection,
    public readonly vm: Omit<MuseVM, "authToken">,
    public readonly vms: ReadonlyArray<Omit<MuseVM, "authToken">>,
  ) {}

  get closed(): boolean {
    return this.connection.closed;
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    return this.connection.onDisconnect(listener);
  }

  static async connect(options: ConnectOptions): Promise<MuseClient> {
    const account = new MuseAccount(options);
    for (let attempt = 0; ; attempt++) {
      const vms = await account.listVMs();
      const vm = options.vmId ? vms.find((v) => v.id === options.vmId) : vms.find((v) => v.isDefault) ?? vms[0];
      if (!vm) {
        throw new MuseError(options.vmId ? "找不到所选的 Muse VM" : "当前账号没有可用的 Muse VM");
      }
      const host = account.credentials.noiseHost || "hatch.metaaivm.com";
      if (/[\s/@?#\\]/u.test(host)) throw new MuseError("无效的 Noise 主机地址");
      const url = `wss://${host}/v1/noise?vm_id=${encodeURIComponent(vm.id)}`;
      try {
        const connection = await NoiseConnection.connect(url, vm.authToken, options.createSocket);
        const { authToken: _ignored, ...publicVM } = vm;
        const publicVMs = vms.map(({ authToken: _t, ...rest }) => rest);
        return new MuseClient(connection, publicVM, publicVMs);
      } catch (error) {
        if (attempt === 0 && error instanceof NoiseUpgradeError) {
          // Edge credentials may have rotated independently; refresh device token and retry once.
          if (account.credentials.refreshToken) {
            await account.refresh().catch(() => undefined);
          }
          continue;
        }
        throw error;
      }
    }
  }

  async sendMessage(message: string, options: SendOptions = {}): Promise<ChatAcknowledgement> {
    const timeout = AbortSignal.timeout(60_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    signal.throwIfAborted();
    const body = chatRequest(message, options);
    signal.throwIfAborted();
    const response = await this.connection.open("/chat/stream", body, { method: "POST", signal });
    try {
      if (response.status < 200 || response.status >= 300) {
        throw new MuseHttpError(response.status, "/chat/stream");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new MuseProtocolError("发送确认响应超出大小上限");
        chunks.push(chunk);
      }
      const raw = object(JSON.parse(Buffer.concat(chunks).toString()));
      const result = object(raw.result ?? raw);
      return {
        messageId: requiredString(result.message_id, "message acknowledgement ID"),
        replyToMessageId: typeof result.reply_to_message_id === "string" ? result.reply_to_message_id : undefined,
        raw,
      };
    } finally {
      response.close();
    }
  }

  async *chat(message: string, options: ChatOptions = {}): AsyncGenerator<TurnEvent> {
    const owned = options.ownsChat ? options.sessionId : undefined;
    if (owned && this.#ownedChats.has(owned)) {
      throw new MuseError("当前会话已有进行中的对话，请等待回复完成或先停止");
    }
    if (owned) this.#ownedChats.add(owned);
    try {
      yield* followTurn(this, message, { ...options, replayScope: options.replayScope ?? this.#replayScope });
    } finally {
      if (owned) this.#ownedChats.delete(owned);
    }
  }

  async subscribe(options: SubscribeOptions = {}): Promise<AsyncIterable<ChatEvent> & { close(): void }> {
    const response = await this.connection.open(
      "/chat/subscribe",
      options.sessionId ? { session_id: options.sessionId } : {},
      { method: "POST", ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (response.status < 200 || response.status >= 300) {
      response.close();
      throw new MuseHttpError(response.status, "/chat/subscribe");
    }
    let consumed = false;
    return {
      close: response.close,
      [Symbol.asyncIterator]: async function* () {
        if (consumed) throw new MuseError("同一个订阅流只能消费一次");
        consumed = true;
        try {
          yield* decodeChatEvents(response.body);
        } finally {
          response.close();
        }
      },
    };
  }

  close(): void {
    this.connection.close();
  }

  /**
   * Best-effort fetch of recent Main Chat history from the Muse VM (`GET /chat/history`).
   * Returns `[]` if the VM disables history or returns a non-2xx status.
   */
  async fetchHistory(limit = 40): Promise<MuseHistoryItem[]> {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 100);
    let response;
    try {
      response = await this.connection.open(`/chat/history?limit=${safeLimit}`, undefined, {
        method: "GET",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return [];
    }
    try {
      if (response.status < 200 || response.status >= 300) return [];
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) return [];
        chunks.push(chunk);
      }
      const parsed = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = object(parsed.result ?? parsed);
      const events = Array.isArray(result.chat_events) ? result.chat_events : [];
      const byId = new Map<string, MuseHistoryItem>();
      for (const rawEntry of events) {
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
        const entry = rawEntry as Record<string, unknown>;
        const eventName = typeof entry.event_name === "string" ? entry.event_name : "";
        if (eventName !== "message.user" && eventName !== "message.assistant") continue;
        const payload =
          entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)
            ? (entry.payload as Record<string, unknown>)
            : {};
        if (payload.is_thread === true) continue;
        if (payload.display_text_ready === false || entry.display_text_ready === false) continue;
        const visibility = payload.visibility ?? entry.visibility;
        if (typeof visibility === "string" && visibility !== "public") continue;
        const messageId =
          typeof entry.message_id === "string" && entry.message_id
            ? entry.message_id
            : typeof payload.message_id === "string" && payload.message_id
              ? payload.message_id
              : "";
        if (!messageId) continue;
        const role: "user" | "assistant" = eventName === "message.user" ? "user" : "assistant";
        let rawText: unknown = entry.display_text ?? payload.display_text;
        if (typeof rawText !== "string" && role === "assistant") {
          rawText = transcriptText(payload.transcript, messageId);
        }
        if (typeof rawText !== "string") {
          rawText = payload.content ?? payload.text;
        }
        if (typeof rawText !== "string") continue;
        const text = cleanControlChars(rawText).trim();
        if (!text) continue;
        const occurredAtMs =
          typeof entry.occurred_at_ms === "number" && Number.isFinite(entry.occurred_at_ms)
            ? entry.occurred_at_ms
            : typeof payload.display_text_updated_at_ms === "number"
              ? payload.display_text_updated_at_ms
              : Date.now();
        byId.set(messageId, { messageId, role, text, occurredAtMs });
      }
      return [...byId.values()].sort((a, b) => a.occurredAtMs - b.occurredAtMs);
    } catch {
      return [];
    } finally {
      response.close();
    }
  }
}
