import { chmod, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import {
  DISPATCH_PROTOCOL_VERSION,
  IceServerEntrySchema,
  RdIceEventDataSchema,
  RdStateEventDataSchema,
  T3ReadResultSchema,
  T3StartResultSchema,
  newNonce,
  ulid,
  type CmdFrame,
  type HelloDispatch,
  type IceServerEntry,
  type LaunchModeName,
  type RdIceEventData,
  type RdStateEventData,
  TUNNEL_OPEN_KIND,
} from "@you-brain/protocol";

import { DEFAULT_CLIENT_ICE_SERVERS } from "../deck/remote-desktop/types.js";
import type { DispatchRelayFrame, TelegramRelayState } from "../deck/telegram/relay.js";
import { writeFileAtomic } from "../domain/atomic.js";
import type { DispatchEmitEvent, DispatchExecutor } from "./executor.js";
import type { DeviceIdentity } from "./identity.js";
import type { CommandOutcome } from "./ledger.js";
import { PeerPins, TunnelClient, TunnelHost, type TunnelSession, type TunnelTty7Handler } from "./tunnel.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_RESULT_BYTES = 256 * 1024;
const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const WAIT_TIMEOUT_ERROR = "等待目标设备结果超时";
const DISCONNECTED_ERROR = "和中转的连接断开了";
const NOT_CONNECTED_ERROR = "还没连上中转";
const DEFAULT_VERSION = "0.0.0";

export interface DispatchLink {
  request<T>(op: string, params?: Record<string, unknown>): Promise<T>;
}

export type OutboxStatus = "sending" | "running" | "waiting" | "done" | "failed";

export interface OutboxEntry {
  dispatchId: string;
  to: string;
  deviceName: string;
  projectId: string;
  title: string;
  mode: LaunchModeName;
  cmdId: string;
  threadId?: string;
  threadUrl?: string;
  status: OutboxStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
  lastSummary?: string;
}

export interface DispatchDeviceInfo {
  id: string;
  name: string;
  online: boolean;
  self: boolean;
  enrolled: boolean;
  publicKey?: string;
  dispatch?: HelloDispatch;
}

export interface DispatchStartInput {
  projectId: string;
  title: string;
  prompt: string;
  mode?: LaunchModeName;
}

export type DispatchStartResult =
  | {
      ok: true;
      dispatchId: string;
      threadId: string;
      threadUrl: string;
      mode: LaunchModeName;
      capped: boolean;
      entry: OutboxEntry;
    }
  | {
      ok: false;
      dispatchId: string;
      error: string;
      entry: OutboxEntry;
    };

export type DispatchFollowupResult =
  | { ok: true; dispatchId: string; threadId: string }
  | { ok: false; dispatchId: string; error: string };

export type DispatchReadResult =
  | {
      ok: true;
      dispatchId: string;
      state: "planning" | "running" | "ready" | "failed";
      summary: string;
      error?: string;
      link: string | null;
      entry: OutboxEntry;
    }
  | { ok: false; dispatchId: string; error: string };

export type DispatchRdStreamEvent =
  | { from: string; kind: "rd.ice"; data: RdIceEventData }
  | { from: string; kind: "rd.state"; data: RdStateEventData };

export interface DispatchTurnResponse {
  iceServers: IceServerEntry[];
  ttl: number;
}

export interface DispatchHubOptions {
  dataDir: string;
  deviceId: string;
  deviceName: string;
  identity: DeviceIdentity;
  /** null 表示本机不接受派活，只作为发起端使用。 */
  executor: DispatchExecutor | null;
  version?: string;
  now?: () => number;
  timeoutMs?: number;
  onEvent?(entry: OutboxEntry, event: { kind: string; data: unknown }): void;
  newId?: () => string;
  /** T3 / tty7 隧道：本机 T3 的地址、配对凭据与 tty7 处理器。缺省则本机既不开放也不发起隧道。 */
  t3Tunnel?: {
    localUrl(): Promise<string>;
    pairCredential(): Promise<string | null>;
    tty7?: TunnelTty7Handler;
  };
}

interface StoredOutboxRecord {
  to: string;
  deviceName: string;
  projectId: string;
  title: string;
  mode: LaunchModeName;
  cmdId: string;
  threadId?: string;
  threadUrl?: string;
  status: OutboxStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
  lastSummary?: string;
}

interface PendingWaiter {
  timer: ReturnType<typeof setTimeout>;
  resolve(outcome: CommandOutcome): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLaunchMode(value: unknown): value is LaunchModeName {
  return value === "auto-accept-edits" || value === "auto" || value === "full-access";
}

function isOutboxStatus(value: unknown): value is OutboxStatus {
  return value === "sending" || value === "running" || value === "waiting" || value === "done" || value === "failed";
}

function parseOutboxEntry(dispatchId: string, value: unknown): OutboxEntry | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.to !== "string" ||
    typeof value.deviceName !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.title !== "string" ||
    !isLaunchMode(value.mode) ||
    typeof value.cmdId !== "string" ||
    !isOutboxStatus(value.status) ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    return null;
  }
  const entry: OutboxEntry = {
    dispatchId,
    to: value.to,
    deviceName: value.deviceName,
    projectId: value.projectId,
    title: value.title,
    mode: value.mode,
    cmdId: value.cmdId,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (typeof value.threadId === "string") entry.threadId = value.threadId;
  if (typeof value.threadUrl === "string") entry.threadUrl = value.threadUrl;
  if (typeof value.error === "string") entry.error = value.error;
  if (typeof value.lastSummary === "string") entry.lastSummary = value.lastSummary;
  return entry;
}

function toStoredRecord(entry: OutboxEntry): StoredOutboxRecord {
  const record: StoredOutboxRecord = {
    to: entry.to,
    deviceName: entry.deviceName,
    projectId: entry.projectId,
    title: entry.title,
    mode: entry.mode,
    cmdId: entry.cmdId,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  if (entry.threadId !== undefined) record.threadId = entry.threadId;
  if (entry.threadUrl !== undefined) record.threadUrl = entry.threadUrl;
  if (entry.error !== undefined) record.error = entry.error;
  if (entry.lastSummary !== undefined) record.lastSummary = entry.lastSummary;
  return record;
}

function mapReadState(state: "planning" | "running" | "ready" | "failed"): OutboxStatus {
  if (state === "ready") return "done";
  if (state === "failed") return "failed";
  return "running";
}

function mapThreadEventStatus(status: string): OutboxStatus | null {
  switch (status) {
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "planning":
      return "running";
    case "waiting":
      return "waiting";
    case "completed":
    case "ready":
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * 设备端派活中枢：同时承担发起端（签名发指令、等结果、维护 outbox、收状态事件）
 * 与目标端（接收指令、按 cmdId 并发去重、转交 DispatchExecutor、回报结果与状态事件）。
 */
export class DispatchHub {
  readonly #outboxFile: string;
  readonly #deviceId: string;
  readonly #deviceName: string;
  readonly #identity: DeviceIdentity;
  readonly #executor: DispatchExecutor | null;
  readonly #version: string;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #onEvent: DispatchHubOptions["onEvent"];
  readonly #newId: () => string;
  readonly #tunnelHost: TunnelHost | null;
  readonly #tunnelClient: TunnelClient | null;

  #link: DispatchLink | null = null;
  #devices: DispatchDeviceInfo[] = [];
  readonly #waiters = new Map<string, PendingWaiter>();
  readonly #inFlight = new Map<string, Promise<CommandOutcome>>();
  readonly #rdListeners = new Set<(event: DispatchRdStreamEvent) => void>();
  #outboxQueue: Promise<unknown> = Promise.resolve();
  #outbox: Map<string, OutboxEntry> | null = null;

  constructor(options: DispatchHubOptions) {
    this.#outboxFile = join(options.dataDir, "dispatch", "outbox.json");
    this.#deviceId = options.deviceId;
    this.#deviceName = options.deviceName;
    this.#identity = options.identity;
    this.#executor = options.executor;
    this.#version = options.version ?? DEFAULT_VERSION;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#onEvent = options.onEvent;
    this.#newId = options.newId ?? (() => ulid(this.#now()));
    const tunnel = options.t3Tunnel;
    const sendTun = async (to: string, sid: string, d: string): Promise<void> => {
      const link = this.#link;
      if (!link) throw new Error(NOT_CONNECTED_ERROR);
      await link.request("tun", { to, sid, d });
    };
    this.#tunnelHost =
      tunnel && this.#executor
        ? new TunnelHost({
            deviceId: this.#deviceId,
            authorize: (frame) => this.#executor!.authorizeView(frame),
            signTranscript: (transcript) => this.#identity.signTranscript(transcript),
            localUrl: tunnel.localUrl,
            pairCredential: tunnel.pairCredential,
            ...(tunnel.tty7 ? { tty7: tunnel.tty7 } : {}),
            send: sendTun,
          })
        : null;
    this.#tunnelClient = tunnel
      ? new TunnelClient({
          deviceId: this.#deviceId,
          dispatch: (to, kind, args, opts) => this.dispatch(to, kind, args, opts),
          send: sendTun,
          peerKey: (id) => this.#devices.find((device) => device.id === id)?.publicKey,
          pins: new PeerPins(options.dataDir),
        })
      : null;
  }

  /** 到另一台设备的 T3 隧道（握手后复用）；本机没有启用 T3 隧道时抛错。 */
  async t3Tunnel(deviceId: string): Promise<TunnelSession> {
    if (!this.#tunnelClient) throw new Error("本机没有启用 T3 隧道");
    if (!this.#link) throw new Error(NOT_CONNECTED_ERROR);
    return this.#tunnelClient.session(deviceId);
  }

  /** 向中转申请 STUN / TURN 凭据；中转不可达或旧版不支持时回落到公共 STUN 节点。 */
  async turnCredentials(): Promise<DispatchTurnResponse> {
    const link = this.#link;
    if (!link) {
      return { iceServers: DEFAULT_CLIENT_ICE_SERVERS, ttl: 3_600 };
    }
    try {
      const raw = await link.request<unknown>("turn");
      if (isRecord(raw) && Array.isArray(raw.iceServers)) {
        const servers: IceServerEntry[] = [];
        for (const item of raw.iceServers) {
          const parsed = IceServerEntrySchema.safeParse(item);
          if (parsed.success) servers.push(parsed.data);
        }
        const ttl = typeof raw.ttl === "number" && Number.isFinite(raw.ttl) && raw.ttl > 0
          ? Math.trunc(raw.ttl)
          : 43_200;
        if (servers.length > 0) {
          return { iceServers: servers, ttl };
        }
      }
    } catch {
      // 旧版中转或网络瞬断时回落公共 STUN
    }
    return { iceServers: DEFAULT_CLIENT_ICE_SERVERS, ttl: 3_600 };
  }

  /** 订阅目标端发回的远程桌面增量 ICE 与状态事件（供 Web / HTTP SSE 使用）。 */
  subscribeRemoteDesktopEvents(listener: (event: DispatchRdStreamEvent) => void): () => void {
    this.#rdListeners.add(listener);
    return () => {
      this.#rdListeners.delete(listener);
    };
  }

  /** 连上或断开中转时由桥调用；连上自动发 hello，断开立即让等待中的请求失败。 */
  attach(link: DispatchLink | null): void {
    const previous = this.#link;
    if (link === null) {
      this.#link = null;
      this.#failAllWaiters(DISCONNECTED_ERROR);
      this.#closeTunnels();
      return;
    }
    if (previous !== null && previous !== link) {
      this.#failAllWaiters(DISCONNECTED_ERROR);
      this.#closeTunnels();
    }
    this.#link = link;
    void this.refreshHello();
  }

  /** 策略或 T3 状态变化后调用，重新向中转上报能力。失败吞掉不抛。 */
  async refreshHello(): Promise<void> {
    const link = this.#link;
    if (!link) return;
    try {
      const dispatch: HelloDispatch = this.#executor
        ? await this.#executor.hello()
        : { enabled: false, t3: { ready: false }, projects: [], maxMode: "auto" };
      if (this.#link !== link) return;
      await link.request("hello", {
        protocolVersion: DISPATCH_PROTOCOL_VERSION,
        version: this.#version,
        dispatch,
      });
    } catch {
      // hello 失败不影响连接，下次策略变化或重连会再上报。
    }
  }

  /** 供 DispatchExecutor 的 `emitEvent` 回调接入，把目标端会话状态变化发往发起端。 */
  emitEvent(to: string, frame: DispatchEmitEvent): void {
    const link = this.#link;
    if (!link) return;
    try {
      void link
        .request("event", {
          to,
          dispatchId: frame.dispatchId,
          kind: frame.kind,
          data: frame.data,
        })
        .catch(() => undefined);
    } catch {
      // 事件发送失败吞掉，不影响执行器。
    }
  }

  /** 收到中转 `state` 帧时更新本机看到的设备列表。 */
  setState(state: TelegramRelayState): void {
    this.#devices = state.devices.map((device) => {
      const item: DispatchDeviceInfo = {
        id: device.id,
        name: device.name,
        online: device.online,
        self: device.id === this.#deviceId,
        enrolled: device.enrolled === true,
      };
      if (typeof device.publicKey === "string") item.publicKey = device.publicKey;
      if (isRecord(device.dispatch)) item.dispatch = structuredClone(device.dispatch) as HelloDispatch;
      return item;
    });
  }

  devices(): DispatchDeviceInfo[] {
    return this.#devices.map((device) => ({
      ...device,
      ...(device.dispatch ? { dispatch: structuredClone(device.dispatch) } : {}),
    }));
  }

  /** 接收中转推来的 `cmd` / `cmdres` / `event` 帧。 */
  onFrame(frame: DispatchRelayFrame): void {
    if (frame.t === "cmd") {
      void this.#handleCmd(frame);
    } else if (frame.t === "cmdres") {
      this.#handleCmdRes(frame);
    } else if (frame.t === "event") {
      void this.#handleEvent(frame);
    } else if (frame.t === "tun") {
      const from = typeof frame.from === "string" ? frame.from : "";
      const sid = typeof frame.sid === "string" ? frame.sid : "";
      const data = typeof frame.d === "string" ? frame.d : "";
      if (from === "" || sid === "" || data === "") return;
      // 会话 id 只属于其中一边：目标端查自己的会话表，发起端查自己的，另一边找不到就丢弃。
      this.#tunnelHost?.onFrame(from, sid, data);
      this.#tunnelClient?.onFrame(from, sid, data);
    }
  }

  #closeTunnels(): void {
    this.#tunnelHost?.closeAll();
    this.#tunnelClient?.closeAll();
    this.#executor?.closeRemoteDesktop(DISCONNECTED_ERROR);
  }

  /** 发送一条签名指令并等待目标端回传 `cmdres`。 */
  async dispatch(
    to: string,
    kind: string,
    args: unknown,
    options?: { timeoutMs?: number; cmdId?: string },
  ): Promise<CommandOutcome> {
    const link = this.#link;
    if (!link) return { ok: false, error: NOT_CONNECTED_ERROR };

    const cmdId = options?.cmdId ?? `c-${this.#newId()}`;
    const ts = this.#now();
    const nonce = newNonce();
    const cmd = { kind, args };

    let sig: string;
    try {
      sig = await this.#identity.sign({ cmdId, from: this.#deviceId, to, ts, nonce, cmd });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    if (this.#link !== link) return { ok: false, error: DISCONNECTED_ERROR };

    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs;
    // 先挂等待者再发请求：内存假中转或低延迟场景下 cmdres 可能先于 cmd 受理回执到达。
    const previousWaiter = this.#waiters.get(cmdId);
    if (previousWaiter) {
      clearTimeout(previousWaiter.timer);
      this.#waiters.delete(cmdId);
      previousWaiter.resolve({ ok: false, error: "同一指令被新请求覆盖" });
    }

    let resolveWaiter!: (outcome: CommandOutcome) => void;
    const resultPromise = new Promise<CommandOutcome>((resolve) => {
      resolveWaiter = resolve;
    });
    const timer = setTimeout(() => {
      if (this.#waiters.get(cmdId) !== waiter) return;
      this.#waiters.delete(cmdId);
      resolveWaiter({ ok: false, error: WAIT_TIMEOUT_ERROR });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    const waiter: PendingWaiter = { timer, resolve: resolveWaiter };
    this.#waiters.set(cmdId, waiter);

    try {
      await link.request("cmd", { cmdId, to, cmd, ts, nonce, sig });
    } catch (error) {
      if (this.#waiters.get(cmdId) === waiter) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(cmdId);
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    return resultPromise;
  }

  /** 向目标设备发起一次派活会话；若等待结果超时，内部复用同一 cmdId 与 dispatchId 重试一次。 */
  async startThread(
    to: string,
    input: DispatchStartInput,
    options?: { timeoutMs?: number; retries?: number },
  ): Promise<DispatchStartResult> {
    const dispatchId = `d-${this.#newId()}`;
    const cmdId = `c-${this.#newId()}`;
    const createdAt = this.#now();
    const deviceName = this.#devices.find((device) => device.id === to)?.name ?? (to === this.#deviceId ? this.#deviceName : to);
    const initialMode: LaunchModeName = input.mode ?? "auto";

    const initial: OutboxEntry = {
      dispatchId,
      to,
      deviceName,
      projectId: input.projectId,
      title: input.title,
      mode: initialMode,
      cmdId,
      status: "sending",
      createdAt,
      updatedAt: createdAt,
    };
    await this.#enqueueOutbox(async () => {
      const table = await this.#loadOutbox();
      table.set(dispatchId, { ...initial });
      this.#pruneOutbox(table, this.#now());
      await this.#saveOutbox(table);
    });

    const args = {
      projectId: input.projectId,
      title: input.title,
      prompt: input.prompt,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      dispatchId,
    };

    const retries = Math.max(0, options?.retries ?? 1);
    let outcome: CommandOutcome = { ok: false, error: WAIT_TIMEOUT_ERROR };
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      outcome = await this.dispatch(to, "t3.start", args, {
        cmdId,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      if (outcome.ok || outcome.error !== WAIT_TIMEOUT_ERROR) break;
    }

    if (!outcome.ok) {
      const failed = await this.#updateOutbox(dispatchId, (entry) => ({
        ...entry,
        status: "failed",
        error: outcome.error,
        updatedAt: this.#now(),
      }));
      return {
        ok: false,
        dispatchId,
        error: outcome.error,
        entry: failed ?? { ...initial, status: "failed", error: outcome.error, updatedAt: this.#now() },
      };
    }

    const parsed = T3StartResultSchema.safeParse(outcome.result);
    if (!parsed.success) {
      const error = "目标设备返回了无效的派活结果";
      const failed = await this.#updateOutbox(dispatchId, (entry) => ({
        ...entry,
        status: "failed",
        error,
        updatedAt: this.#now(),
      }));
      return {
        ok: false,
        dispatchId,
        error,
        entry: failed ?? { ...initial, status: "failed", error, updatedAt: this.#now() },
      };
    }

    const updated = await this.#updateOutbox(dispatchId, (entry) => {
      const next: OutboxEntry = {
        ...entry,
        threadId: parsed.data.threadId,
        threadUrl: parsed.data.threadUrl,
        mode: parsed.data.mode,
        status: entry.status === "sending" ? "running" : entry.status,
        updatedAt: this.#now(),
      };
      delete next.error;
      return next;
    });

    const finalEntry: OutboxEntry = updated ?? {
      ...initial,
      threadId: parsed.data.threadId,
      threadUrl: parsed.data.threadUrl,
      mode: parsed.data.mode,
      status: "running",
      updatedAt: this.#now(),
    };

    return {
      ok: true,
      dispatchId,
      threadId: parsed.data.threadId,
      threadUrl: parsed.data.threadUrl,
      mode: parsed.data.mode,
      capped: parsed.data.capped,
      entry: finalEntry,
    };
  }

  /** 向已发起的派活会话追加一条指令。 */
  async followup(dispatchId: string, prompt: string, options?: { timeoutMs?: number }): Promise<DispatchFollowupResult> {
    const entry = await this.getOutbox(dispatchId);
    if (!entry) return { ok: false, dispatchId, error: "找不到这个派活记录" };
    if (!entry.threadId) return { ok: false, dispatchId, error: "这个派活还没有创建会话" };
    const requestId = `r-${this.#newId()}`;
    const outcome = await this.dispatch(
      entry.to,
      "t3.followup",
      { threadId: entry.threadId, prompt, requestId },
      options,
    );
    if (!outcome.ok) return { ok: false, dispatchId, error: outcome.error };
    await this.#updateOutbox(dispatchId, (current) => {
      const next: OutboxEntry = { ...current, status: "running", updatedAt: this.#now() };
      delete next.error;
      return next;
    });
    return { ok: true, dispatchId, threadId: entry.threadId };
  }

  /** 读取已发起的派活会话状态与摘要，并同步更新 outbox。 */
  async read(dispatchId: string, options?: { timeoutMs?: number }): Promise<DispatchReadResult> {
    const entry = await this.getOutbox(dispatchId);
    if (!entry) return { ok: false, dispatchId, error: "找不到这个派活记录" };
    if (!entry.threadId) return { ok: false, dispatchId, error: "这个派活还没有创建会话" };
    const outcome = await this.dispatch(entry.to, "t3.read", { threadId: entry.threadId }, options);
    if (!outcome.ok) return { ok: false, dispatchId, error: outcome.error };

    const parsed = T3ReadResultSchema.safeParse(outcome.result);
    if (!parsed.success) return { ok: false, dispatchId, error: "目标设备返回了无效的会话状态" };

    const mappedStatus = mapReadState(parsed.data.state);
    const updated = await this.#updateOutbox(dispatchId, (current) => {
      const next: OutboxEntry = {
        ...current,
        status: mappedStatus,
        lastSummary: parsed.data.summary,
        updatedAt: this.#now(),
      };
      if (parsed.data.error !== undefined) next.error = parsed.data.error;
      else if (mappedStatus !== "failed") delete next.error;
      return next;
    });

    const finalEntry: OutboxEntry = updated ?? {
      ...entry,
      status: mappedStatus,
      lastSummary: parsed.data.summary,
      updatedAt: this.#now(),
      ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
    };

    return {
      ok: true,
      dispatchId,
      state: parsed.data.state,
      summary: parsed.data.summary,
      ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
      link: parsed.data.link,
      entry: finalEntry,
    };
  }

  outbox(): Promise<OutboxEntry[]> {
    return this.#enqueueOutbox(async () => {
      const table = await this.#loadOutbox();
      if (this.#pruneOutbox(table, this.#now())) {
        await this.#saveOutbox(table);
      }
      return [...table.values()]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((entry) => ({ ...entry }));
    });
  }

  getOutbox(dispatchId: string): Promise<OutboxEntry | null> {
    return this.#enqueueOutbox(async () => {
      const table = await this.#loadOutbox();
      if (this.#pruneOutbox(table, this.#now())) {
        await this.#saveOutbox(table);
      }
      const found = table.get(dispatchId);
      return found ? { ...found } : null;
    });
  }

  #failAllWaiters(reason: string): void {
    for (const [cmdId, waiter] of this.#waiters) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(cmdId);
      waiter.resolve({ ok: false, error: reason });
    }
  }

  async #handleCmd(frame: DispatchRelayFrame): Promise<void> {
    const cmdId = typeof frame.cmdId === "string" ? frame.cmdId : "";
    if (!cmdId) return;

    let pending = this.#inFlight.get(cmdId);
    const isLeader = pending === undefined;
    if (!pending) {
      pending = this.#executeCmd(frame).finally(() => {
        if (this.#inFlight.get(cmdId) === pending) this.#inFlight.delete(cmdId);
      });
      this.#inFlight.set(cmdId, pending);
    }

    const outcome = await pending;
    if (!isLeader) return;
    await this.#sendResult(cmdId, outcome);
  }

  async #executeCmd(frame: DispatchRelayFrame): Promise<CommandOutcome> {
    if ((frame.cmd as { kind?: unknown } | undefined)?.kind === TUNNEL_OPEN_KIND) {
      if (!this.#tunnelHost) return { ok: false, error: "本机没有开放 T3 查看" };
      try {
        return await this.#tunnelHost.open(frame as unknown as CmdFrame);
      } catch {
        return { ok: false, error: "T3 隧道握手失败" };
      }
    }
    if (!this.#executor) return { ok: false, error: "本机不接受派活" };
    try {
      return await this.#executor.handle(frame as unknown as CmdFrame);
    } catch {
      return { ok: false, error: "派活执行失败" };
    }
  }

  async #sendResult(cmdId: string, outcome: CommandOutcome): Promise<void> {
    const link = this.#link;
    if (!link) return;
    try {
      if (outcome.ok) {
        const payload = { cmdId, ok: true as const, result: outcome.result };
        let oversized = false;
        try {
          oversized = Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_RESULT_BYTES;
        } catch {
          oversized = true;
        }
        if (oversized) {
          await link.request("result", { cmdId, ok: false, error: "结果过大" });
        } else {
          await link.request("result", payload);
        }
      } else {
        await link.request("result", { cmdId, ok: false, error: outcome.error });
      }
    } catch {
      // 发送结果失败吞掉，不影响连接。
    }
  }

  #handleCmdRes(frame: DispatchRelayFrame): void {
    const cmdId = typeof frame.cmdId === "string" ? frame.cmdId : "";
    if (!cmdId) return;
    const waiter = this.#waiters.get(cmdId);
    if (!waiter) return;
    this.#waiters.delete(cmdId);
    clearTimeout(waiter.timer);
    if (frame.ok === true) {
      waiter.resolve({ ok: true, result: frame.result });
    } else {
      waiter.resolve({
        ok: false,
        error: typeof frame.error === "string" ? frame.error : "目标设备执行失败",
      });
    }
  }

  async #handleEvent(frame: DispatchRelayFrame): Promise<void> {
    const from = typeof frame.from === "string" ? frame.from : "";
    if (from && (frame.kind === "rd.ice" || frame.kind === "rd.state")) {
      if (this.#rdListeners.size === 0) return;
      if (frame.kind === "rd.ice") {
        const parsed = RdIceEventDataSchema.safeParse(frame.data);
        if (!parsed.success) return;
        const event: DispatchRdStreamEvent = { from, kind: "rd.ice", data: parsed.data };
        for (const listener of this.#rdListeners) {
          try {
            listener(event);
          } catch {
            // 监听器异常不影响中枢。
          }
        }
        return;
      }
      const parsed = RdStateEventDataSchema.safeParse(frame.data);
      if (!parsed.success) return;
      const event: DispatchRdStreamEvent = { from, kind: "rd.state", data: parsed.data };
      for (const listener of this.#rdListeners) {
        try {
          listener(event);
        } catch {
          // 监听器异常不影响中枢。
        }
      }
      return;
    }

    if (frame.kind !== "thread.status") return;
    const dispatchId = typeof frame.dispatchId === "string" ? frame.dispatchId : "";
    if (!from || !dispatchId || !isRecord(frame.data)) return;
    const rawStatus = typeof frame.data.status === "string" ? frame.data.status : "";

    const updated = await this.#enqueueOutbox(async () => {
      const table = await this.#loadOutbox();
      this.#pruneOutbox(table, this.#now());
      const entry = table.get(dispatchId);
      if (!entry || entry.to !== from) return null;
      const mapped = mapThreadEventStatus(rawStatus);
      const next: OutboxEntry = {
        ...entry,
        status: mapped ?? entry.status,
        updatedAt: this.#now(),
      };
      table.set(dispatchId, next);
      await this.#saveOutbox(table);
      return { ...next };
    });

    if (!updated) return;
    try {
      this.#onEvent?.(updated, { kind: frame.kind, data: frame.data });
    } catch {
      // 上层事件回调抛错不影响中枢。
    }
  }

  #enqueueOutbox<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#outboxQueue.then(task, task);
    this.#outboxQueue = run.catch(() => undefined);
    return run;
  }

  #updateOutbox(dispatchId: string, updater: (entry: OutboxEntry) => OutboxEntry): Promise<OutboxEntry | null> {
    return this.#enqueueOutbox(async () => {
      const table = await this.#loadOutbox();
      const existing = table.get(dispatchId);
      if (!existing) return null;
      const next = updater({ ...existing });
      table.set(dispatchId, next);
      this.#pruneOutbox(table, this.#now());
      await this.#saveOutbox(table);
      return { ...next };
    });
  }

  async #loadOutbox(): Promise<Map<string, OutboxEntry>> {
    if (this.#outbox) return this.#outbox;
    let text: string;
    try {
      text = await readFile(this.#outboxFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#outbox = new Map();
        return this.#outbox;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await this.#backupCorrupt();
      this.#outbox = new Map();
      return this.#outbox;
    }

    if (!isRecord(parsed)) {
      await this.#backupCorrupt();
      this.#outbox = new Map();
      return this.#outbox;
    }

    const table = new Map<string, OutboxEntry>();
    for (const [dispatchId, value] of Object.entries(parsed)) {
      const entry = parseOutboxEntry(dispatchId, value);
      if (entry) table.set(dispatchId, entry);
    }
    this.#outbox = table;
    return table;
  }

  async #backupCorrupt(): Promise<void> {
    try {
      await rename(this.#outboxFile, `${this.#outboxFile}.corrupt-${this.#now()}`);
    } catch {
      // 备份失败也不阻止从空开始。
    }
  }

  #pruneOutbox(table: Map<string, OutboxEntry>, now: number): boolean {
    let changed = false;
    for (const [dispatchId, entry] of table) {
      if (now - entry.createdAt > OUTBOX_RETENTION_MS) {
        table.delete(dispatchId);
        changed = true;
      }
    }
    return changed;
  }

  async #saveOutbox(table: Map<string, OutboxEntry>): Promise<void> {
    const body: Record<string, StoredOutboxRecord> = {};
    for (const [dispatchId, entry] of table) {
      body[dispatchId] = toStoredRecord(entry);
    }
    await writeFileAtomic(this.#outboxFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.#outboxFile, 0o600);
  }
}
