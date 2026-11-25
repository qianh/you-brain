import type { RelayAuditEntry } from "./audit.js";

/**
 * 设备间指令路由与 hello/cmd/result/event 规则（协议第 2、3 节）。
 * 纯逻辑模块，不依赖 Bun.serve；所有外部依赖通过端口注入，便于单元测试。
 */

export type SocketAuth = "enrolled" | "legacy";

export interface DispatchSocket {
  deviceId: string;
  name: string;
  auth: SocketAuth;
  send(frame: string): void;
}

export interface HelloDispatch {
  enabled: boolean;
  t3: {
    ready: boolean;
    version?: string;
  };
  projects: Array<{ id: string; name: string }>;
  maxMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  viewT3?: boolean;
  remoteDesktop?: boolean;
  role?: "desktop" | "server";
}

export interface RelayTurnConfig {
  /** 逗号分隔或数组形式的 turn:/turns: URL 列表。 */
  urls: string[];
  /** coturn static-auth-secret，用于动态签发临时 TURN 凭据。 */
  secret?: string;
  /** 凭据有效秒数，默认 43200（12 小时）。 */
  ttlSeconds?: number;
}

export interface RelayIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export const DEFAULT_STUN_URLS = [
  "stun:stun.chat.bilibili.com:3478",
  "stun:stun.miwifi.com:3478",
] as const;

export type DispatchTimer = ReturnType<typeof globalThis.setTimeout>;

export interface DispatchPorts {
  /** 当前在线设备连接。 */
  sockets(): DispatchSocket[];
  now(): number;
  /** 写审计日志。 */
  audit(entry: RelayAuditEntry): Promise<void> | void;
  /** hello 变更后广播 state。 */
  broadcast(): Promise<void> | void;
  /** 把超时回调放回外部串行队列；未提供时直接同步执行。 */
  enqueue?(task: () => Promise<void> | void): void;
  /** 待结果超时毫秒数，默认 5 分钟。 */
  pendingTimeoutMs?: number;
  /** 可选 TURN 中继配置（未配置时仅下发默认公共 STUN 节点）。 */
  turn?: RelayTurnConfig;
  /** 可选定时器注入，方便测试。 */
  setTimer?: (fn: () => void, ms: number) => DispatchTimer;
  clearTimer?: (timer: DispatchTimer) => void;
}

interface PendingCommand {
  from: string;
  to: string;
  kind: string;
  expiresAt: number;
  timer: DispatchTimer;
}

const HELLO_DISPATCH_MAX_BYTES = 8 * 1024;
const CMD_FRAME_MAX_BYTES = 64 * 1024;
const RESULT_FRAME_MAX_BYTES = 256 * 1024;
const EVENT_FRAME_MAX_BYTES = 64 * 1024;
const CMD_TTL_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const CMD_RATE_LIMIT = 30;
const EVENT_RATE_LIMIT = 120;
/** T3 隧道帧（端到端加密，中转只转发）：单帧上限与每台发起设备每分钟的帧数。 */
const TUN_FRAME_MAX_BYTES = 160 * 1024;
const TUN_RATE_LIMIT = 12_000;
const TUN_SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DEFAULT_PENDING_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TURN_TTL_SECONDS = 12 * 3600;

const ALLOWED_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const SAFE_KIND_RE = /^[A-Za-z0-9._:-]{1,64}$/;

async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Buffer.from(sig).toString("base64");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeAuditKind(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && SAFE_KIND_RE.test(raw)) return raw;
  return fallback;
}

function sendJson(socket: DispatchSocket, payload: Record<string, unknown>): boolean {
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function validateHelloDispatch(value: unknown): { ok: true; dispatch: HelloDispatch } | { ok: false; error: string } {
  if (!isPlainObject(value)) return { ok: false, error: "hello.dispatch 格式不合法" };
  if (typeof value.enabled !== "boolean") return { ok: false, error: "hello.dispatch.enabled 必须是布尔值" };
  if (!isPlainObject(value.t3) || typeof value.t3.ready !== "boolean") {
    return { ok: false, error: "hello.dispatch.t3 格式不合法" };
  }
  if (value.t3.version !== undefined && (typeof value.t3.version !== "string" || value.t3.version.length === 0)) {
    return { ok: false, error: "hello.dispatch.t3.version 格式不合法" };
  }
  if (!Array.isArray(value.projects)) return { ok: false, error: "hello.dispatch.projects 必须是数组" };
  const projects: Array<{ id: string; name: string }> = [];
  for (const item of value.projects) {
    if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.name !== "string") {
      return { ok: false, error: "hello.dispatch.projects 条目不合法" };
    }
    projects.push({ id: item.id, name: item.name });
  }
  if (typeof value.maxMode !== "string" || !ALLOWED_MODES.has(value.maxMode)) {
    return { ok: false, error: "hello.dispatch.maxMode 不合法" };
  }
  if (value.viewT3 !== undefined && typeof value.viewT3 !== "boolean") {
    return { ok: false, error: "hello.dispatch.viewT3 必须是布尔值" };
  }
  if (value.remoteDesktop !== undefined && typeof value.remoteDesktop !== "boolean") {
    return { ok: false, error: "hello.dispatch.remoteDesktop 必须是布尔值" };
  }
  if (value.role !== undefined && value.role !== "desktop" && value.role !== "server") {
    return { ok: false, error: "hello.dispatch.role 不合法" };
  }
  const normalized: HelloDispatch = {
    enabled: value.enabled,
    t3: {
      ready: value.t3.ready,
      ...(value.t3.version !== undefined ? { version: value.t3.version } : {}),
    },
    projects,
    maxMode: value.maxMode as HelloDispatch["maxMode"],
    ...(value.viewT3 !== undefined ? { viewT3: value.viewT3 } : {}),
    ...(value.remoteDesktop !== undefined ? { remoteDesktop: value.remoteDesktop } : {}),
    ...(value.role !== undefined ? { role: value.role } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > HELLO_DISPATCH_MAX_BYTES) {
    return { ok: false, error: "hello.dispatch 内容过大" };
  }
  return { ok: true, dispatch: normalized };
}

export class DispatchRouter {
  readonly #ports: DispatchPorts;
  readonly #hellos = new Map<string, HelloDispatch>();
  readonly #pending = new Map<string, PendingCommand>();
  /** `${from}\0${nonce}` → 过期时间戳 */
  readonly #nonces = new Map<string, number>();
  /** 发起方 deviceId → 最近 1 分钟 cmd 时间戳列表 */
  readonly #cmdRates = new Map<string, number[]>();
  /** 目标方 deviceId → 最近 1 分钟 event 时间戳列表 */
  readonly #eventRates = new Map<string, number[]>();
  /** 发起方 deviceId → 当前 1 分钟窗口的隧道帧数（帧很多，用固定窗口计数而不是时间戳列表）。 */
  readonly #tunRates = new Map<string, { start: number; count: number }>();
  #stopped = false;

  constructor(ports: DispatchPorts) {
    this.#ports = ports;
  }

  getHello(deviceId: string): HelloDispatch | undefined {
    const found = this.#hellos.get(deviceId);
    return found === undefined ? undefined : structuredClone(found);
  }

  /** 清理某个设备的 hello 缓存与作为目标的待结果项（吊销时用）。 */
  async clearDevice(deviceId: string): Promise<void> {
    this.#hellos.delete(deviceId);
    await this.#failPendingForTarget(deviceId);
  }

  /** 设备断开时，将该设备作为目标的待结果立即失败回给发起方。 */
  async onDisconnect(deviceId: string): Promise<void> {
    if (this.#ports.sockets().some((socket) => socket.deviceId === deviceId)) return;
    await this.#failPendingForTarget(deviceId);
  }

  /** 清理全部待结果定时器，停止后不再触发超时回调。 */
  stop(): void {
    this.#stopped = true;
    const clear = this.#ports.clearTimer ?? ((timer: DispatchTimer) => globalThis.clearTimeout(timer));
    for (const entry of this.#pending.values()) clear(entry.timer);
    this.#pending.clear();
  }

  /**
   * 尝试处理 `hello` / `cmd` / `result` / `event` 帧。
   * 返回 `true` 表示已由本路由处理；`false` 表示交给原有 `RelayCore`。
   */
  async handleFrame(socket: DispatchSocket, raw: string): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isPlainObject(parsed) || parsed.t !== "req" || typeof parsed.id !== "string") return false;
    const op = parsed.op;
    if (op !== "hello" && op !== "cmd" && op !== "result" && op !== "event" && op !== "tun" && op !== "turn") return false;

    const id = parsed.id;
    const byteLength = Buffer.byteLength(raw, "utf8");
    switch (op) {
      case "hello":
        await this.#handleHello(socket, id, parsed);
        return true;
      case "cmd":
        await this.#handleCmd(socket, id, parsed, byteLength);
        return true;
      case "result":
        await this.#handleResult(socket, id, parsed, byteLength);
        return true;
      case "event":
        await this.#handleEvent(socket, id, parsed, byteLength);
        return true;
      case "tun":
        await this.#handleTun(socket, id, parsed, byteLength);
        return true;
      case "turn":
        await this.#handleTurn(socket, id);
        return true;
    }
  }

  /**
   * 为已入网设备下发 STUN + 可选动态 TURN 临时凭据（coturn static-auth-secret HMAC-SHA1）。
   */
  async #handleTurn(socket: DispatchSocket, id: string): Promise<void> {
    const now = this.#ports.now();
    if (socket.auth !== "enrolled") {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: null, kind: "turn", outcome: "rejected:not_enrolled" });
      sendJson(socket, { t: "res", id, ok: false, error: "请先入网" });
      return;
    }
    const iceServers: RelayIceServer[] = [{ urls: [...DEFAULT_STUN_URLS] }];
    const turn = this.#ports.turn;
    const ttl = turn?.ttlSeconds && turn.ttlSeconds > 0 ? Math.floor(turn.ttlSeconds) : DEFAULT_TURN_TTL_SECONDS;
    const cleanUrls = (turn?.urls ?? []).map((u) => u.trim()).filter((u) => /^turns?:/iu.test(u));
    if (cleanUrls.length > 0) {
      if (turn?.secret && turn.secret.length > 0) {
        const expiry = Math.floor(now / 1000) + ttl;
        const username = `${expiry}:${socket.deviceId}`;
        const credential = await hmacSha1Base64(turn.secret, username);
        iceServers.push({ urls: cleanUrls, username, credential });
      } else {
        iceServers.push({ urls: cleanUrls });
      }
    }
    sendJson(socket, { t: "res", id, ok: true, result: { iceServers, ttl } });
  }

  /**
   * T3 隧道帧：`d` 是端到端加密后的密文，中转不解析、不存、不逐帧审计，只校验双方都已入网、转发并限速。
   * 目标不在线立即回错，不排队。
   */
  async #handleTun(socket: DispatchSocket, id: string, frame: Record<string, unknown>, byteLength: number): Promise<void> {
    const now = this.#ports.now();
    const to = typeof frame.to === "string" ? frame.to.trim() : "";
    if (socket.auth !== "enrolled") {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: to || null, kind: "tun", outcome: "rejected:not_enrolled" });
      sendJson(socket, { t: "res", id, ok: false, error: "请先入网" });
      return;
    }
    if (byteLength > TUN_FRAME_MAX_BYTES) {
      sendJson(socket, { t: "res", id, ok: false, error: "隧道帧过大" });
      return;
    }
    const sid = typeof frame.sid === "string" ? frame.sid : "";
    if (to === "" || !TUN_SID_RE.test(sid) || typeof frame.d !== "string" || frame.d === "") {
      sendJson(socket, { t: "res", id, ok: false, error: "隧道帧格式不合法" });
      return;
    }
    if (!this.#consumeWindow(socket.deviceId, now)) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: "tun", outcome: "rejected:rate_limited" });
      sendJson(socket, { t: "res", id, ok: false, error: "隧道流量过大" });
      return;
    }
    const target = this.#findEnrolledSocket(to);
    if (!target) {
      sendJson(socket, { t: "res", id, ok: false, error: "目标设备不在线" });
      return;
    }
    const delivered = sendJson(target, { t: "tun", from: socket.deviceId, sid, d: frame.d });
    sendJson(socket, delivered ? { t: "res", id, ok: true, result: {} } : { t: "res", id, ok: false, error: "目标设备不在线" });
  }

  async #handleHello(socket: DispatchSocket, id: string, frame: Record<string, unknown>): Promise<void> {
    const now = this.#ports.now();
    if (socket.auth !== "enrolled") {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: null, kind: "hello", outcome: "rejected:not_enrolled" });
      sendJson(socket, { t: "res", id, ok: false, error: "请先入网" });
      return;
    }
    if (frame.protocolVersion !== undefined && frame.protocolVersion !== 1) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: null, kind: "hello", outcome: "rejected:bad_version" });
      sendJson(socket, { t: "res", id, ok: false, error: "不支持的协议版本" });
      return;
    }
    const checked = validateHelloDispatch(frame.dispatch);
    if (!checked.ok) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: null, kind: "hello", outcome: "rejected:invalid_frame" });
      sendJson(socket, { t: "res", id, ok: false, error: checked.error });
      return;
    }
    this.#hellos.set(socket.deviceId, checked.dispatch);
    await this.#ports.broadcast();
    sendJson(socket, { t: "res", id, ok: true, result: {} });
  }

  async #handleCmd(socket: DispatchSocket, id: string, frame: Record<string, unknown>, byteLength: number): Promise<void> {
    const now = this.#ports.now();
    const toRaw = typeof frame.to === "string" && frame.to.length > 0 ? frame.to : null;
    if (socket.auth !== "enrolled") {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: toRaw, kind: "cmd", outcome: "rejected:not_enrolled" });
      sendJson(socket, { t: "res", id, ok: false, error: "请先入网" });
      return;
    }
    if (byteLength > CMD_FRAME_MAX_BYTES) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: toRaw, kind: "cmd", outcome: "rejected:too_large" });
      sendJson(socket, { t: "res", id, ok: false, error: "指令过大" });
      return;
    }
    const cmdId = typeof frame.cmdId === "string" ? frame.cmdId.trim() : "";
    const to = typeof frame.to === "string" ? frame.to.trim() : "";
    const cmd = isPlainObject(frame.cmd) ? frame.cmd : null;
    const cmdKindRaw = cmd && typeof cmd.kind === "string" ? cmd.kind.trim() : "";
    const ts = frame.ts;
    const nonce = typeof frame.nonce === "string" ? frame.nonce : "";
    const sig = typeof frame.sig === "string" ? frame.sig : "";
    if (
      cmdId.length === 0 ||
      to.length === 0 ||
      cmd === null ||
      cmdKindRaw.length === 0 ||
      typeof ts !== "number" ||
      !Number.isFinite(ts) ||
      nonce.length === 0 ||
      sig.length === 0
    ) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: toRaw, kind: "cmd", outcome: "rejected:invalid_frame" });
      sendJson(socket, { t: "res", id, ok: false, error: "指令格式不合法" });
      return;
    }
    const auditKind = safeAuditKind(cmdKindRaw, "cmd");

    if (!this.#consumeRate(this.#cmdRates, socket.deviceId, CMD_RATE_LIMIT, now)) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "rejected:rate_limited" });
      sendJson(socket, { t: "res", id, ok: false, error: "发送过于频繁，请稍后再试" });
      return;
    }

    if (Math.abs(now - ts) > CMD_TTL_MS) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "rejected:expired" });
      sendJson(socket, { t: "res", id, ok: false, error: "指令已过期" });
      return;
    }

    this.#pruneNonces(now);
    const nonceKey = `${socket.deviceId}\0${nonce}`;
    const existingNonce = this.#nonces.get(nonceKey);
    if (existingNonce !== undefined && existingNonce > now) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "rejected:replay" });
      sendJson(socket, { t: "res", id, ok: false, error: "重复的指令（nonce 重放）" });
      return;
    }

    if (this.#pending.has(cmdId)) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "rejected:duplicate_cmd" });
      sendJson(socket, { t: "res", id, ok: false, error: "指令正在处理中" });
      return;
    }

    const target = this.#findSocket(to);
    if (!target) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "rejected:offline" });
      sendJson(socket, { t: "res", id, ok: false, error: "目标设备不在线" });
      return;
    }
    if (target.auth !== "enrolled") {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "rejected:target_not_enrolled" });
      sendJson(socket, { t: "res", id, ok: false, error: "目标设备未入网" });
      return;
    }

    // 全部校验通过：记录 nonce、登记待结果超时、转发给目标设备。
    this.#nonces.set(nonceKey, Math.max(now, ts) + CMD_TTL_MS);

    const timeoutMs = this.#ports.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
    const set: (fn: () => void, ms: number) => DispatchTimer =
      this.#ports.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    const timer = set(() => {
      const run = () => this.#expirePending(cmdId);
      if (this.#ports.enqueue) this.#ports.enqueue(run);
      else void run();
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    this.#pending.set(cmdId, {
      from: socket.deviceId,
      to,
      kind: auditKind,
      expiresAt: now + timeoutMs,
      timer,
    });

    const delivered = sendJson(target, {
      t: "cmd",
      cmdId,
      from: socket.deviceId,
      to,
      cmd: frame.cmd,
      ts,
      nonce,
      sig,
    });
    if (!delivered) {
      const clear = this.#ports.clearTimer ?? ((t: DispatchTimer) => globalThis.clearTimeout(t));
      clear(timer);
      this.#pending.delete(cmdId);
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "rejected:offline" });
      sendJson(socket, { t: "res", id, ok: false, error: "目标设备不在线" });
      return;
    }

    await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "accepted" });
    sendJson(socket, { t: "res", id, ok: true, result: { accepted: true } });
  }

  async #handleResult(socket: DispatchSocket, id: string, frame: Record<string, unknown>, byteLength: number): Promise<void> {
    const now = this.#ports.now();
    if (socket.auth !== "enrolled") {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: null, kind: "result", outcome: "rejected:not_enrolled" });
      sendJson(socket, { t: "res", id, ok: false, error: "请先入网" });
      return;
    }
    const cmdId = typeof frame.cmdId === "string" ? frame.cmdId.trim() : "";
    if (cmdId.length === 0) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: null, kind: "result", outcome: "rejected:invalid_frame" });
      sendJson(socket, { t: "res", id, ok: false, error: "缺少 cmdId" });
      return;
    }
    const pending = this.#pending.get(cmdId);
    if (!pending) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: null, kind: "result", outcome: "rejected:unknown_cmd" });
      sendJson(socket, { t: "res", id, ok: false, error: "未知或已结束的指令" });
      return;
    }
    if (pending.to !== socket.deviceId) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: pending.from, kind: pending.kind, outcome: "rejected:wrong_sender" });
      sendJson(socket, { t: "res", id, ok: false, error: "无权回传该指令结果" });
      return;
    }

    // 命中合法目标设备：立即消费待结果记录（只接受一次）。
    this.#pending.delete(cmdId);
    const clear = this.#ports.clearTimer ?? ((t: DispatchTimer) => globalThis.clearTimeout(t));
    clear(pending.timer);

    const sender = this.#findEnrolledSocket(pending.from);
    if (byteLength > RESULT_FRAME_MAX_BYTES) {
      if (sender) {
        sendJson(sender, { t: "cmdres", cmdId, from: socket.deviceId, ok: false, error: "结果过大" });
      }
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: pending.from, kind: pending.kind, outcome: "rejected:result_too_large" });
      sendJson(socket, { t: "res", id, ok: false, error: "结果过大" });
      return;
    }

    const ok = frame.ok === true;
    if (sender) {
      if (ok) {
        sendJson(sender, {
          t: "cmdres",
          cmdId,
          from: socket.deviceId,
          ok: true,
          result: frame.result === undefined ? null : frame.result,
        });
      } else {
        const error = typeof frame.error === "string" && frame.error.length > 0 ? frame.error : "目标设备执行失败";
        sendJson(sender, { t: "cmdres", cmdId, from: socket.deviceId, ok: false, error });
      }
    }

    await this.#ports.audit({
      ts: now,
      from: socket.deviceId,
      to: pending.from,
      kind: pending.kind,
      outcome: ok ? "result:ok" : "result:error",
    });
    sendJson(socket, { t: "res", id, ok: true, result: {} });
  }

  async #handleEvent(socket: DispatchSocket, id: string, frame: Record<string, unknown>, byteLength: number): Promise<void> {
    const now = this.#ports.now();
    const toRaw = typeof frame.to === "string" && frame.to.length > 0 ? frame.to : null;
    if (socket.auth !== "enrolled") {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: toRaw, kind: "event", outcome: "rejected:not_enrolled" });
      sendJson(socket, { t: "res", id, ok: false, error: "请先入网" });
      return;
    }
    if (byteLength > EVENT_FRAME_MAX_BYTES) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: toRaw, kind: "event", outcome: "rejected:too_large" });
      sendJson(socket, { t: "res", id, ok: false, error: "事件过大" });
      return;
    }
    const to = typeof frame.to === "string" ? frame.to.trim() : "";
    const dispatchId = typeof frame.dispatchId === "string" ? frame.dispatchId.trim() : "";
    const kind = typeof frame.kind === "string" ? frame.kind.trim() : "";
    if (to.length === 0 || dispatchId.length === 0 || kind.length === 0 || frame.data === undefined) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to: toRaw, kind: "event", outcome: "rejected:invalid_frame" });
      sendJson(socket, { t: "res", id, ok: false, error: "事件格式不合法" });
      return;
    }
    const auditKind = `event:${safeAuditKind(kind, "unknown")}`;

    if (!this.#consumeRate(this.#eventRates, to, EVENT_RATE_LIMIT, now)) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "rejected:rate_limited" });
      sendJson(socket, { t: "res", id, ok: false, error: "事件过于频繁" });
      return;
    }

    const target = this.#findEnrolledSocket(to);
    if (!target) {
      await this.#ports.audit({ ts: now, from: socket.deviceId, to, kind: auditKind, outcome: "dropped:offline" });
      sendJson(socket, { t: "res", id, ok: true, result: { delivered: false } });
      return;
    }

    const delivered = sendJson(target, {
      t: "event",
      from: socket.deviceId,
      dispatchId,
      kind,
      data: frame.data,
    });
    await this.#ports.audit({
      ts: now,
      from: socket.deviceId,
      to,
      kind: auditKind,
      outcome: delivered ? "delivered" : "dropped:offline",
    });
    sendJson(socket, { t: "res", id, ok: true, result: { delivered } });
  }

  async #expirePending(cmdId: string): Promise<void> {
    if (this.#stopped) return;
    const pending = this.#pending.get(cmdId);
    if (!pending) return;
    this.#pending.delete(cmdId);
    const now = this.#ports.now();
    const sender = this.#findEnrolledSocket(pending.from);
    if (sender) {
      sendJson(sender, {
        t: "cmdres",
        cmdId,
        from: pending.to,
        ok: false,
        error: "目标设备没有返回结果",
      });
    }
    await this.#ports.audit({
      ts: now,
      from: pending.to,
      to: pending.from,
      kind: pending.kind,
      outcome: "failed:timeout",
    });
  }

  async #failPendingForTarget(targetDeviceId: string): Promise<void> {
    const clear = this.#ports.clearTimer ?? ((t: DispatchTimer) => globalThis.clearTimeout(t));
    const now = this.#ports.now();
    const matched: Array<[string, PendingCommand]> = [];
    for (const [cmdId, entry] of this.#pending) {
      if (entry.to === targetDeviceId) matched.push([cmdId, entry]);
    }
    for (const [cmdId, entry] of matched) {
      this.#pending.delete(cmdId);
      clear(entry.timer);
      const sender = this.#findEnrolledSocket(entry.from);
      if (sender) {
        sendJson(sender, {
          t: "cmdres",
          cmdId,
          from: targetDeviceId,
          ok: false,
          error: "目标设备已断开",
        });
      }
      await this.#ports.audit({
        ts: now,
        from: targetDeviceId,
        to: entry.from,
        kind: entry.kind,
        outcome: "failed:target_disconnected",
      });
    }
  }

  #findSocket(deviceId: string): DispatchSocket | undefined {
    return this.#ports.sockets().find((socket) => socket.deviceId === deviceId);
  }

  #findEnrolledSocket(deviceId: string): DispatchSocket | undefined {
    return this.#ports.sockets().find((socket) => socket.deviceId === deviceId && socket.auth === "enrolled");
  }

  #pruneNonces(now: number): void {
    for (const [key, expiresAt] of this.#nonces) {
      if (expiresAt <= now) this.#nonces.delete(key);
    }
  }

  #consumeWindow(key: string, now: number): boolean {
    let entry = this.#tunRates.get(key);
    if (!entry || now - entry.start >= RATE_WINDOW_MS) {
      entry = { start: now, count: 0 };
      this.#tunRates.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= TUN_RATE_LIMIT;
  }

  #consumeRate(bucket: Map<string, number[]>, key: string, limit: number, now: number): boolean {
    const cutoff = now - RATE_WINDOW_MS;
    const list = (bucket.get(key) ?? []).filter((ts) => ts > cutoff);
    if (list.length >= limit) {
      bucket.set(key, list);
      return false;
    }
    list.push(now);
    bucket.set(key, list);
    return true;
  }
}
