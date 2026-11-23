import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  TUNNEL_CHUNK_BYTES,
  TUNNEL_RELAY_FRAME_MAX,
  TUNNEL_OPEN_KIND,
  TUNNEL_WS_GZIP_CAP,
  decodeTunnelMessage,
  deriveTunnelCipher,
  encodeTunnelMessage,
  newTunnelEphemeral,
  tunnelTranscript,
  verifyTunnelTranscript,
  type CmdFrame,
  type TunnelCipher,
  type TunnelMessage,
  type TunnelTarget,
} from "@you-brain/protocol";

import { validTerminalSize, type TerminalConnection, type TerminalSize, type Tty7TerminalEvents } from "../deck/tty7-terminal.js";
import { writeFileAtomic } from "../domain/atomic.js";
import type { CommandOutcome } from "./ledger.js";
import type { DispatchSender } from "./policy.js";

/**
 * 设备间 T3 隧道（协议文档 §9）：把一台设备的指挥台里「另一台设备的 T3 与终端会话」经中转安全地搬过来。
 * 这里是传输层：通道（加密 + 保序）、目标端（把请求转给本机 T3 或 tty7）、发起端（HTTP / WebSocket 经隧道发出去）。
 * 本地转发（deck/t3/proxy.ts）与远端 tty7 桥（deck/tty7-tunnel.ts）通过 TunnelSession 的 fetch / socket / pair 使用它。
 */
export const TUNNEL_VIRTUAL_ORIGIN = "http://t3.tunnel";
/** 对端新版本处理 target="tty7" 时在响应头里带上此标记；旧版本转发给 T3 时不会带，用于识别旧版本。 */
export const TUNNEL_TTY7_HEADER = "x-ubrain-tty7";
/** 经隧道传输的实时终端二进制帧单块上限（小于 TUNNEL_CHUNK_BYTES，保证加密和 base64url 后远低于中转帧上限）。 */
export const TUNNEL_TTY7_CHUNK_BYTES = 48 * 1024;
/** 启用 ws-gzip 时单次尝试压缩的终端输出原始块大小（典型 ANSI/UTF-8 压缩率 8～15 倍，192 KB 压缩后约 15 KB）。 */
const TTY7_GZIP_RAW_BLOCK_BYTES = 192 * 1024;
/** 终端小碎帧聚合时间窗（毫秒）：合并高频细碎输出，碰到控制事件时同步立即刷出。 */
const TERMINAL_COALESCE_MS = 4;
const WS_GZIP_MIN_BYTES = 512;
const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024;
const TTY7_TERMINAL_PATH = "/api/deck/tty7/terminal";

const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const IDLE_MS = 10 * 60_000;
const HEAD_TIMEOUT_MS = 60_000;
const OPEN_TIMEOUT_MS = 20_000;
const MAX_AHEAD = 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_SESSIONS_PER_PEER = 4;
const MAX_SESSIONS = 16;

type Send = (to: string, sid: string, data: string) => Promise<void>;
type Headers2 = Array<[string, string]>;

/** 一条隧道的一端：负责加密、按计数器保序、重放与篡改一律丢弃并关闭。 */
export class TunnelChannel {
  readonly #cipher: TunnelCipher;
  readonly #send: (data: string) => Promise<void>;
  readonly #onMessage: (message: TunnelMessage) => void;
  readonly #onBroken: () => void;
  #expected = 0;
  readonly #ahead = new Map<number, Buffer>();
  lastUsed = Date.now();

  constructor(cipher: TunnelCipher, send: (data: string) => Promise<void>, onMessage: (message: TunnelMessage) => void, onBroken: () => void) {
    this.#cipher = cipher;
    this.#send = send;
    this.#onMessage = onMessage;
    this.#onBroken = onBroken;
  }

  receive(data: string): void {
    let opened: { counter: number; plaintext: Buffer };
    try {
      opened = this.#cipher.open(data);
    } catch {
      this.#onBroken();
      return;
    }
    this.lastUsed = Date.now();
    if (opened.counter < this.#expected || this.#ahead.has(opened.counter)) return;
    this.#ahead.set(opened.counter, opened.plaintext);
    if (this.#ahead.size > MAX_AHEAD) {
      this.#onBroken();
      return;
    }
    for (let next = this.#ahead.get(this.#expected); next !== undefined; next = this.#ahead.get(this.#expected)) {
      this.#ahead.delete(this.#expected);
      this.#expected += 1;
      try {
        this.#onMessage(decodeTunnelMessage(next));
      } catch {
        this.#onBroken();
        return;
      }
    }
  }

  post(message: TunnelMessage): Promise<void> {
    this.lastUsed = Date.now();
    const plain = encodeTunnelMessage(message);
    // 先估算再封装：封装会消耗计数器，超限的帧被中转丢掉后，对端按计数器保序会永远等它。
    if (Math.ceil((plain.length + 24) / 3) * 4 > TUNNEL_RELAY_FRAME_MAX) return Promise.reject(new Error("隧道帧超过中转上限"));
    return this.#send(this.#cipher.seal(plain));
  }
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function* chunks(bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += TUNNEL_CHUNK_BYTES) yield bytes.subarray(offset, offset + TUNNEL_CHUNK_BYTES);
}

/**
 * 编码单条 WebSocket 消息：
 * - 旧版对端（`!wsGzip`）原样发单帧；
 * - 新版对端（`wsGzip`）对 >= 512B 的文本/二进制消息尝试 gzip（level 1），并对超大消息按 48 KB 自动分片（`more: true`），
 *   避免 T3 大体积快照 JSON 超过中转单帧 160 KB 上限被丢弃。
 */
function encodeWsFrames(id: string, data: string | Uint8Array, wsGzip: boolean): Array<Extract<TunnelMessage, { k: "ws-msg" }>> {
  const isText = typeof data === "string";
  if (!wsGzip) {
    return [isText ? { k: "ws-msg", id, text: data } : { k: "ws-msg", id, body: b64(data) }];
  }
  const raw = isText ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (raw.length < WS_GZIP_MIN_BYTES && raw.length <= TUNNEL_TTY7_CHUNK_BYTES) {
    return [isText ? { k: "ws-msg", id, text: data } : { k: "ws-msg", id, body: b64(raw) }];
  }
  const gz = raw.length >= WS_GZIP_MIN_BYTES ? gzipSync(raw, { level: 1 }) : null;
  const useGzip = gz !== null && (gz.length + 16 < raw.length || (isText && raw.length > TUNNEL_TTY7_CHUNK_BYTES));
  if (!useGzip && raw.length <= TUNNEL_TTY7_CHUNK_BYTES) {
    return [isText ? { k: "ws-msg", id, text: data } : { k: "ws-msg", id, body: b64(raw) }];
  }
  const payload = useGzip ? gz! : raw;
  const out: Array<Extract<TunnelMessage, { k: "ws-msg" }>> = [];
  const total = Math.max(1, Math.ceil(payload.length / TUNNEL_TTY7_CHUNK_BYTES));
  for (let index = 0; index < total; index += 1) {
    const part = payload.subarray(index * TUNNEL_TTY7_CHUNK_BYTES, Math.min(payload.length, (index + 1) * TUNNEL_TTY7_CHUNK_BYTES));
    const encoded = b64(part);
    const more = index < total - 1;
    out.push({
      k: "ws-msg",
      id,
      ...(isText ? { text: encoded } : { body: encoded }),
      ...(useGzip ? { enc: "gzip" as const } : {}),
      ...(more ? { more: true } : {}),
    });
  }
  return out;
}

class WsReassembler {
  #parts: Buffer[] = [];
  #bytes = 0;

  push(message: Extract<TunnelMessage, { k: "ws-msg" }>): { kind: "text"; text: string } | { kind: "binary"; bytes: Buffer } | null {
    const isGzip = message.enc === "gzip";
    const isMultipart = message.more !== undefined || this.#parts.length > 0;
    if (!isGzip && !isMultipart) {
      if (message.text !== undefined) return { kind: "text", text: message.text };
      if (message.body !== undefined) return { kind: "binary", bytes: Buffer.from(message.body, "base64") };
      return { kind: "text", text: "" };
    }
    const isText = message.text !== undefined;
    const chunk = Buffer.from((isText ? message.text : message.body) ?? "", "base64");
    this.#bytes += chunk.length;
    if (this.#bytes > MAX_WS_MESSAGE_BYTES) {
      this.#parts = [];
      this.#bytes = 0;
      throw new Error("WebSocket 消息过大");
    }
    this.#parts.push(chunk);
    if (message.more === true) return null;
    const joined = this.#parts.length === 1 ? this.#parts[0]! : Buffer.concat(this.#parts);
    this.#parts = [];
    this.#bytes = 0;
    const decoded = isGzip ? gunzipSync(joined, { maxOutputLength: MAX_WS_MESSAGE_BYTES }) : joined;
    return isText ? { kind: "text", text: decoded.toString("utf8") } : { kind: "binary", bytes: decoded };
  }
}

/** 同时在途的帧数。每帧都要等中转应答，逐帧串行时吞吐 = 帧大小 / 往返延迟，提高窗口可充分利用带宽延迟积。 */
const SEND_WINDOW = 16;

/**
 * 滑动窗口发送：帧的计数器在 `post` 调用时就按顺序定下了，接收端本来就按计数器重排，
 * 所以可以并发在途；任何一帧失败，后面的 `post` 与 `flush` 都抛出同一个错误。
 */
class Pipeline {
  readonly #inflight = new Set<Promise<void>>();
  #failure: { error: unknown } | null = null;

  #check(): void {
    if (this.#failure) throw this.#failure.error;
  }

  async post(send: () => Promise<void>): Promise<void> {
    this.#check();
    const task: Promise<void> = send()
      .catch((error: unknown) => {
        this.#failure ??= { error };
      })
      .finally(() => this.#inflight.delete(task));
    this.#inflight.add(task);
    while (this.#inflight.size >= SEND_WINDOW) await Promise.race(this.#inflight);
    this.#check();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#inflight]);
    this.#check();
  }
}

const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "keep-alive", "upgrade", "content-length", "accept-encoding", "transfer-encoding", "te", "trailer"]);
/** 文本类响应值得压缩；图片、字体、压缩包本身已压缩，不再处理。 */
function isCompressible(contentType: string | null): boolean {
  if (contentType === null) return false;
  return /^(?:text\/|application\/(?:javascript|json|manifest\+json|xml|wasm)|image\/svg\+xml)/iu.test(contentType);
}

const SKIP_RESPONSE_HEADERS =new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding", "te", "trailer", "upgrade"]);

function swapOrigin(value: string, from: string, to: string): string {
  return value.startsWith(from) ? to + value.slice(from.length) : value;
}

// ───────────────────────────── 目标端 ─────────────────────────────

export interface TunnelTty7Handler {
  /** 处理来自远端的 tty7 HTTP 请求（仅允许 /api/deck/tty7/*）。 */
  fetch(method: string, path: string, headers: Headers, body: Uint8Array): Promise<Response>;
  /** 打开到本机 tty7 某 pane 的实时终端连接。 */
  openTerminal(pane: number, size: TerminalSize, events: Tty7TerminalEvents): TerminalConnection;
}

export interface TunnelHostOptions {
  deviceId: string;
  authorize(frame: CmdFrame): Promise<{ ok: true; sender: DispatchSender } | { ok: false; error: string }>;
  signTranscript(transcript: string): Promise<string>;
  /** 本机 T3 的地址（http://127.0.0.1:3773/）。 */
  localUrl(): Promise<string>;
  /** 为对端浏览器签发一次性配对凭据；拿不到返回 null。 */
  pairCredential(): Promise<string | null>;
  /** 本机 tty7 终端会话桥；提供后远端可通过同一条加密隧道操作本机终端会话。 */
  tty7?: TunnelTty7Handler;
  send: Send;
  fetch?: typeof fetch;
}

interface HostTerminal {
  connection?: TerminalConnection;
  inFlight: number;
  peerPaused: boolean;
  activeSends: number;
  outQueue: Array<{ message: TunnelMessage; rawBytes: number }>;
  pendingOut: Buffer[];
  pendingOutBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  inbound: WsReassembler;
  closed: boolean;
}

interface HostSocket {
  socket: WebSocket;
  inbound: WsReassembler;
}

interface HostSession {
  from: string;
  sid: string;
  wsGzip: boolean;
  channel: TunnelChannel;
  requests: Map<string, { method: string; path: string; headers: Headers2; parts: Buffer[]; bytes: number; target: TunnelTarget }>;
  sockets: Map<string, HostSocket>;
  terminals: Map<string, HostTerminal>;
  closed: boolean;
}

export class TunnelHost {
  readonly #options: TunnelHostOptions;
  readonly #sessions = new Map<string, HostSession>();
  readonly #fetch: typeof fetch;
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: TunnelHostOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
  }

  /** 处理对端发来的签名指令 t3.tunnel.open；通过授权才建会话并回握手应答。 */
  async open(frame: CmdFrame): Promise<CommandOutcome> {
    const auth = await this.#options.authorize(frame);
    if (!auth.ok) return { ok: false, error: auth.error };
    const args = frame.cmd.args as { sid?: unknown; epk?: unknown; caps?: unknown } | null;
    const sid = typeof args?.sid === "string" ? args.sid : "";
    const epk = typeof args?.epk === "string" ? args.epk : "";
    if (!SID_RE.test(sid) || epk === "") return { ok: false, error: "参数不对：隧道握手" };
    const peerCaps = Array.isArray(args?.caps) ? args.caps.filter((cap): cap is string => typeof cap === "string") : [];
    const wsGzip = peerCaps.includes(TUNNEL_WS_GZIP_CAP);
    const key = `${frame.from}\0${sid}`;
    if (this.#sessions.has(key)) return { ok: false, error: "隧道会话已存在" };
    const mine = [...this.#sessions.values()].filter((session) => session.from === frame.from);
    if (mine.length >= MAX_SESSIONS_PER_PEER) this.#closeOldest(mine);
    if (this.#sessions.size >= MAX_SESSIONS) return { ok: false, error: "本机的隧道数量已达上限" };

    const ephemeral = newTunnelEphemeral();
    let cipher: TunnelCipher;
    try {
      cipher = deriveTunnelCipher({ privateKey: ephemeral.privateKey, peerPublicKey: epk, sid, role: "responder" });
    } catch {
      return { ok: false, error: "参数不对：隧道握手" };
    }
    const sig = await this.#options.signTranscript(
      tunnelTranscript({ sid, initiator: frame.from, responder: this.#options.deviceId, initiatorKey: epk, responderKey: ephemeral.publicKey }),
    );
    const session: HostSession = {
      from: frame.from,
      sid,
      wsGzip,
      channel: undefined as unknown as TunnelChannel,
      requests: new Map(),
      sockets: new Map(),
      terminals: new Map(),
      closed: false,
    };
    session.channel = new TunnelChannel(
      cipher,
      (data) => this.#options.send(frame.from, sid, data),
      (message) => void this.#handle(session, message).catch(() => undefined),
      () => this.#close(session),
    );
    this.#sessions.set(key, session);
    this.#startSweeper();
    return {
      ok: true,
      result: { epk: ephemeral.publicKey, sig, ...(wsGzip ? { caps: [TUNNEL_WS_GZIP_CAP] } : {}) },
    };
  }

  /** 中转转来的加密帧。找不到会话的丢弃（可能是已关闭的会话）。 */
  onFrame(from: string, sid: string, data: string): void {
    this.#sessions.get(`${from}\0${sid}`)?.channel.receive(data);
  }

  closeAll(): void {
    for (const session of [...this.#sessions.values()]) this.#close(session);
  }

  size(): number {
    return this.#sessions.size;
  }

  #closeOldest(sessions: HostSession[]): void {
    const oldest = sessions.reduce((a, b) => (a.channel.lastUsed <= b.channel.lastUsed ? a : b));
    this.#close(oldest);
  }

  #close(session: HostSession): void {
    if (session.closed) return;
    session.closed = true;
    this.#sessions.delete(`${session.from}\0${session.sid}`);
    for (const entry of session.sockets.values()) {
      try {
        entry.socket.close();
      } catch {
        // 已经关了。
      }
    }
    session.sockets.clear();
    for (const terminal of session.terminals.values()) {
      terminal.closed = true;
      if (terminal.flushTimer !== null) {
        clearTimeout(terminal.flushTimer);
        terminal.flushTimer = null;
      }
      terminal.outQueue.length = 0;
      terminal.pendingOut.length = 0;
      try {
        terminal.connection?.close();
      } catch {
        // 已经关了。
      }
    }
    session.terminals.clear();
    session.requests.clear();
    if (this.#sessions.size === 0 && this.#sweeper) {
      clearInterval(this.#sweeper);
      this.#sweeper = null;
    }
  }

  #startSweeper(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.#sessions.values()]) {
        if (now - session.channel.lastUsed > IDLE_MS) this.#close(session);
      }
    }, 60_000);
    (this.#sweeper as { unref?: () => void }).unref?.();
  }

  async #handle(session: HostSession, message: TunnelMessage): Promise<void> {
    switch (message.k) {
      case "req": {
        const entry = {
          method: message.method,
          path: message.path,
          headers: message.headers,
          parts: [] as Buffer[],
          bytes: 0,
          target: (message.target === "tty7" ? "tty7" : "t3") as TunnelTarget,
        };
        if (message.body) this.#append(session, message.id, entry, message.body);
        session.requests.set(message.id, entry);
        if (message.end) await this.#run(session, message.id);
        return;
      }
      case "body": {
        const entry = session.requests.get(message.id);
        if (!entry) return;
        this.#append(session, message.id, entry, message.body);
        if (message.end) await this.#run(session, message.id);
        return;
      }
      case "ws-open":
        if (message.target === "tty7") await this.#openTerminal(session, message);
        else await this.#openSocket(session, message);
        return;
      case "ws-msg": {
        const terminal = session.terminals.get(message.id);
        if (terminal) {
          this.#handleTerminalMessage(session, message.id, terminal, message);
          return;
        }
        const entry = session.sockets.get(message.id);
        if (!entry) return;
        const decoded = entry.inbound.push(message);
        if (!decoded) return;
        if (decoded.kind === "text") entry.socket.send(decoded.text);
        else entry.socket.send(decoded.bytes);
        return;
      }
      case "ws-close": {
        const terminal = session.terminals.get(message.id);
        if (terminal) {
          terminal.closed = true;
          if (terminal.flushTimer !== null) {
            clearTimeout(terminal.flushTimer);
            terminal.flushTimer = null;
          }
          terminal.outQueue.length = 0;
          terminal.pendingOut.length = 0;
          session.terminals.delete(message.id);
          try {
            terminal.connection?.close();
          } catch {
            // 已经关了。
          }
          return;
        }
        session.sockets.get(message.id)?.socket.close();
        session.sockets.delete(message.id);
        return;
      }
      case "pair": {
        let credential: string | null = null;
        try {
          credential = await this.#options.pairCredential();
        } catch {
          credential = null;
        }
        await session.channel.post({ k: "pair-res", id: message.id, credential });
        return;
      }
      case "bye":
        this.#close(session);
        return;
      default:
        return;
    }
  }

  #append(session: HostSession, id: string, entry: { parts: Buffer[]; bytes: number }, body: string): void {
    const bytes = Buffer.from(body, "base64");
    entry.bytes += bytes.length;
    if (entry.bytes > MAX_REQUEST_BYTES) {
      session.requests.delete(id);
      void session.channel.post({ k: "err", id, message: "请求体过大" }).catch(() => undefined);
      return;
    }
    entry.parts.push(bytes);
  }

  async #local(): Promise<{ http: string; ws: string }> {
    const origin = new URL(await this.#options.localUrl()).origin;
    return { http: origin, ws: origin.replace(/^http/u, "ws") };
  }

  #requestHeaders(headers: Headers2, localOrigin: string | null): Headers {
    const out = new Headers();
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (SKIP_REQUEST_HEADERS.has(lower) || lower.startsWith("sec-websocket-")) continue;
      out.append(
        name,
        localOrigin !== null && (lower === "origin" || lower === "referer") ? swapOrigin(value, TUNNEL_VIRTUAL_ORIGIN, localOrigin) : value,
      );
    }
    return out;
  }

  async #run(session: HostSession, id: string): Promise<void> {
    const entry = session.requests.get(id);
    if (!entry) return;
    session.requests.delete(id);
    try {
      if (!/^\/(?!\/)/u.test(entry.path)) throw new Error("路径不合法");
      const body = Buffer.concat(entry.parts);
      let response: Response;
      let localOrigin: string | null = null;
      if (entry.target === "tty7") {
        if (!this.#options.tty7) throw new Error("对端没有提供终端会话服务");
        response = await this.#options.tty7.fetch(entry.method, entry.path, this.#requestHeaders(entry.headers, null), body);
      } else {
        const local = await this.#local();
        localOrigin = local.http;
        response = await this.#fetch(`${local.http}${entry.path}`, {
          method: entry.method,
          headers: this.#requestHeaders(entry.headers, local.http),
          ...(entry.method === "GET" || entry.method === "HEAD" || body.length === 0 ? {} : { body }),
          redirect: "manual",
        });
      }
      const headers: Headers2 = [];
      response.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (SKIP_RESPONSE_HEADERS.has(lower) || lower === "set-cookie") return;
        headers.push([name, localOrigin !== null && lower === "location" ? swapOrigin(value, localOrigin, TUNNEL_VIRTUAL_ORIGIN) : value]);
      });
      if (entry.target === "tty7") headers.push([TUNNEL_TTY7_HEADER, "1"]);
      for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
      const gzip = response.body !== null && isCompressible(response.headers.get("content-type"));
      await session.channel.post({ k: "head", id, status: response.status, statusText: response.statusText, headers, ...(gzip ? { enc: "gzip" as const } : {}) });
      if (response.body === null) {
        await session.channel.post({ k: "chunk", id, body: "", end: true });
        return;
      }
      // 前端资源是大块文本，隧道吞吐受中转往返限制，压缩后传输量约为原来的四分之一。
      const reader = (gzip ? response.body.pipeThrough(new CompressionStream("gzip")) : response.body).getReader();
      const pipeline = new Pipeline();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const part of chunks(value)) await pipeline.post(() => session.channel.post({ k: "chunk", id, body: b64(part), end: false }));
      }
      await pipeline.post(() => session.channel.post({ k: "chunk", id, body: "", end: true }));
      await pipeline.flush();
    } catch (error) {
      const fallback = entry.target === "tty7" ? "对端终端服务没有响应" : "本机 T3 没有响应";
      await session.channel.post({ k: "err", id, message: error instanceof Error ? error.message : fallback }).catch(() => undefined);
    }
  }

  async #openTerminal(session: HostSession, message: Extract<TunnelMessage, { k: "ws-open" }>): Promise<void> {
    try {
      if (message.path !== TTY7_TERMINAL_PATH) throw new Error("路径不合法");
      if (!this.#options.tty7) throw new Error("对端没有提供实时终端服务");
      const terminal: HostTerminal = {
        inFlight: 0,
        peerPaused: false,
        activeSends: 0,
        outQueue: [],
        pendingOut: [],
        pendingOutBytes: 0,
        flushTimer: null,
        inbound: new WsReassembler(),
        closed: false,
      };
      session.terminals.set(message.id, terminal);
      await session.channel.post({ k: "ws-ok", id: message.id });
    } catch (error) {
      session.terminals.delete(message.id);
      await session.channel
        .post({ k: "err", id: message.id, message: error instanceof Error ? error.message : "对端终端连接失败" })
        .catch(() => undefined);
    }
  }

  #handleTerminalMessage(
    session: HostSession,
    id: string,
    terminal: HostTerminal,
    message: Extract<TunnelMessage, { k: "ws-msg" }>,
  ): void {
    if (terminal.closed || session.closed) return;

    // 滑动窗口保序发送：同步调用 channel.post 锁定严格递增的帧计数器，允许最多 SEND_WINDOW 帧并发在途。
    const pump = (): void => {
      while (!session.closed && terminal.activeSends < SEND_WINDOW && terminal.outQueue.length > 0) {
        const item = terminal.outQueue.shift()!;
        terminal.activeSends += 1;
        void session.channel
          .post(item.message)
          .catch(() => undefined)
          .finally(() => {
            terminal.activeSends = Math.max(0, terminal.activeSends - 1);
            if (item.rawBytes > 0) {
              terminal.inFlight = Math.max(0, terminal.inFlight - item.rawBytes);
              if (!terminal.closed && !terminal.peerPaused && terminal.inFlight < 128 * 1024) {
                terminal.connection?.resume();
              }
            }
            pump();
          });
      }
    };

    const flushPendingOut = (): void => {
      if (terminal.flushTimer !== null) {
        clearTimeout(terminal.flushTimer);
        terminal.flushTimer = null;
      }
      if (terminal.pendingOut.length === 0) return;
      const combined = terminal.pendingOut.length === 1 ? terminal.pendingOut[0]! : Buffer.concat(terminal.pendingOut);
      terminal.pendingOut = [];
      terminal.pendingOutBytes = 0;
      if (terminal.closed || session.closed) return;

      if (session.wsGzip) {
        for (let offset = 0; offset < combined.length; offset += TTY7_GZIP_RAW_BLOCK_BYTES) {
          const block = combined.subarray(offset, Math.min(combined.length, offset + TTY7_GZIP_RAW_BLOCK_BYTES));
          if (block.length >= WS_GZIP_MIN_BYTES) {
            const gz = gzipSync(block, { level: 1 });
            if (gz.length + 16 < block.length && gz.length <= TUNNEL_TTY7_CHUNK_BYTES) {
              terminal.outQueue.push({ message: { k: "ws-msg", id, body: b64(gz), enc: "gzip" }, rawBytes: block.length });
              continue;
            }
          }
          for (let sub = 0; sub < block.length; sub += TUNNEL_TTY7_CHUNK_BYTES) {
            const part = block.subarray(sub, Math.min(block.length, sub + TUNNEL_TTY7_CHUNK_BYTES));
            terminal.outQueue.push({ message: { k: "ws-msg", id, body: b64(part) }, rawBytes: part.length });
          }
        }
      } else {
        for (let offset = 0; offset < combined.length; offset += TUNNEL_TTY7_CHUNK_BYTES) {
          const part = combined.subarray(offset, Math.min(combined.length, offset + TUNNEL_TTY7_CHUNK_BYTES));
          terminal.outQueue.push({ message: { k: "ws-msg", id, body: b64(part) }, rawBytes: part.length });
        }
      }
      pump();
    };

    const sendFrame = (frame: TunnelMessage): void => {
      if (session.closed) return;
      flushPendingOut();
      terminal.outQueue.push({ message: frame, rawBytes: 0 });
      pump();
    };

    const sendControl = (payload: unknown): void => {
      if (terminal.closed || session.closed) return;
      sendFrame({ k: "ws-msg", id, text: JSON.stringify(payload) });
    };

    const reject = (reason: string): void => {
      if (terminal.closed) return;
      sendControl({ type: "error", message: reason });
      terminal.closed = true;
      session.terminals.delete(id);
      try {
        terminal.connection?.close();
      } catch {
        // 已经关了。
      }
      sendFrame({ k: "ws-close", id, code: 1008, reason: "Terminal request rejected" });
    };

    try {
      const decoded = terminal.inbound.push(message);
      if (!decoded) return;

      if (!terminal.connection) {
        if (decoded.kind !== "text") {
          reject("请先发送终端连接参数");
          return;
        }
        const request = JSON.parse(decoded.text) as { type?: unknown; pane?: unknown; size?: unknown };
        if (request.type !== "connect" || !Number.isSafeInteger(request.pane) || (request.pane as number) < 0 || !validTerminalSize(request.size)) {
          reject("终端会话或尺寸不正确");
          return;
        }
        const handler = this.#options.tty7;
        if (!handler) {
          reject("对端没有提供实时终端服务");
          return;
        }
        terminal.connection = handler.openTerminal(request.pane as number, request.size, {
          ready: () => sendControl({ type: "ready" }),
          live: () => sendControl({ type: "live" }),
          output(bytes) {
            if (terminal.closed || session.closed || bytes.length === 0) return;
            const copy = Buffer.from(bytes);
            terminal.inFlight += copy.length;
            if (terminal.inFlight >= 512 * 1024) terminal.connection?.pause();
            terminal.pendingOut.push(copy);
            terminal.pendingOutBytes += copy.length;
            if (terminal.pendingOutBytes >= TTY7_GZIP_RAW_BLOCK_BYTES) {
              flushPendingOut();
            } else if (terminal.flushTimer === null) {
              terminal.flushTimer = setTimeout(flushPendingOut, TERMINAL_COALESCE_MS);
            }
          },
          size: (size) => sendControl({ type: "size", size }),
          lease: (by) => sendControl({ type: "lease", by }),
          warning: (text) => sendControl({ type: "warning", message: text }),
          exit: (code) => sendControl({ type: "exit", code }),
          error: (text) => sendControl({ type: "error", message: text }),
          close: () => {
            if (terminal.closed) return;
            flushPendingOut();
            terminal.closed = true;
            session.terminals.delete(id);
            sendFrame({ k: "ws-close", id, code: 1000, reason: "Terminal stream closed" });
          },
        });
        return;
      }

      if (decoded.kind === "binary") {
        terminal.connection.input(decoded.bytes);
        return;
      }
      const request = JSON.parse(decoded.text) as { type?: unknown; size?: unknown };
      if (request.type === "resize" && validTerminalSize(request.size)) {
        terminal.connection.resize(request.size);
      } else if (request.type === "pause") {
        terminal.peerPaused = true;
        terminal.connection.pause();
      } else if (request.type === "resume") {
        terminal.peerPaused = false;
        if (terminal.inFlight < 128 * 1024) terminal.connection.resume();
      } else {
        reject("终端控制消息不正确");
      }
    } catch (error) {
      reject(error instanceof Error ? error.message : "终端请求无效");
    }
  }

  async #openSocket(session: HostSession, message: Extract<TunnelMessage, { k: "ws-open" }>): Promise<void> {
    try {
      if (!/^\/(?!\/)/u.test(message.path)) throw new Error("路径不合法");
      const local = await this.#local();
      const headers: Record<string, string> = {};
      this.#requestHeaders(message.headers, local.http).forEach((value, name) => {
        headers[name] = value;
      });
      const socket = new WebSocket(`${local.ws}${message.path}`, { headers } as unknown as string[]);
      socket.binaryType = "arraybuffer";
      session.sockets.set(message.id, { socket, inbound: new WsReassembler() });
      socket.addEventListener("open", () => void session.channel.post({ k: "ws-ok", id: message.id }).catch(() => undefined));
      socket.addEventListener("message", (event) => {
        const data = event.data as string | ArrayBuffer;
        const frames = encodeWsFrames(message.id, typeof data === "string" ? data : new Uint8Array(data), session.wsGzip);
        for (const frame of frames) void session.channel.post(frame).catch(() => undefined);
      });
      socket.addEventListener("close", (event) => {
        session.sockets.delete(message.id);
        void session.channel.post({ k: "ws-close", id: message.id, code: event.code, reason: event.reason }).catch(() => undefined);
      });
      socket.addEventListener("error", () => {
        void session.channel.post({ k: "err", id: message.id, message: "本机 T3 连接中断" }).catch(() => undefined);
      });
    } catch (error) {
      await session.channel.post({ k: "err", id: message.id, message: error instanceof Error ? error.message : "本机 T3 连接失败" }).catch(() => undefined);
    }
  }
}

// ───────────────────────────── 发起端 ─────────────────────────────

/** 对端设备公钥的首次信任固定：第一次见到记下来，之后中转给的公钥变了就拒绝。 */
export class PeerPins {
  readonly #file: string;

  constructor(dataDir: string) {
    this.#file = join(dataDir, "dispatch", "peers.json");
  }

  async resolve(deviceId: string, offered: string | undefined): Promise<string> {
    const pins = await this.#read();
    const pinned = pins[deviceId];
    if (pinned !== undefined) {
      if (offered !== undefined && offered !== pinned) {
        throw new Error("对端设备的身份密钥变了，已拒绝连接（如果它确实重装过，删掉本机 dispatch/peers.json 里这台设备的记录再试）");
      }
      return pinned;
    }
    if (offered === undefined) throw new Error("中转没有给出这台设备的身份密钥");
    pins[deviceId] = offered;
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFileAtomic(this.#file, `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
    await chmod(this.#file, 0o600);
    return offered;
  }

  async #read(): Promise<Record<string, string>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#file, "utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    } catch {
      return {};
    }
  }
}

type SocketEvent = "open" | "message" | "close" | "error";

/** 给本地转发用的最小 WebSocket：只实现转发实际用到的部分。 */
export class TunnelSocket {
  binaryType: "arraybuffer" | "blob" = "arraybuffer";
  readyState = 0;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly #listeners = new Map<SocketEvent, Array<(event: never) => void>>();
  readonly #outbound: (message: TunnelMessage) => Promise<void>;
  readonly #id: string;
  readonly #wsGzip: boolean;
  readonly #inbound = new WsReassembler();

  constructor(id: string, outbound: (message: TunnelMessage) => Promise<void>, wsGzip = false) {
    this.#id = id;
    this.#outbound = outbound;
    this.#wsGzip = wsGzip;
  }

  addEventListener(type: SocketEvent, listener: (event: never) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    const payload = typeof data === "string" ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const frames = encodeWsFrames(this.#id, payload, this.#wsGzip);
    for (const frame of frames) {
      void this.#outbound(frame).catch(() => this.#finish(1011, "隧道中断"));
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= TunnelSocket.CLOSING) return;
    this.readyState = TunnelSocket.CLOSING;
    void this.#outbound({ k: "ws-close", id: this.#id, code, reason }).catch(() => undefined);
    this.#finish(code, reason);
  }

  /** 以下由会话调用。 */
  _opened(): void {
    this.readyState = TunnelSocket.OPEN;
    this.#emit("open", {});
  }

  _message(message: Extract<TunnelMessage, { k: "ws-msg" }>): void {
    try {
      const decoded = this.#inbound.push(message);
      if (!decoded) return;
      const data =
        decoded.kind === "text"
          ? decoded.text
          : decoded.bytes.buffer.slice(decoded.bytes.byteOffset, decoded.bytes.byteOffset + decoded.bytes.byteLength);
      this.#emit("message", { data });
    } catch (error) {
      this._failed(error instanceof Error ? error.message : "WebSocket 消息解压失败");
    }
  }

  _failed(message?: string): void {
    this.#emit("error", message !== undefined ? { message } : {});
    this.#finish(1011, message ?? "T3 连接中断");
  }

  _closed(code: number, reason: string): void {
    this.#finish(code, reason);
  }

  #finish(code: number, reason: string): void {
    if (this.readyState === TunnelSocket.CLOSED) return;
    this.readyState = TunnelSocket.CLOSED;
    this.#emit("close", { code, reason });
  }

  #emit(type: SocketEvent, event: object): void {
    for (const listener of this.#listeners.get(type) ?? []) (listener as (event: object) => void)(event);
  }
}

interface PendingStream {
  onHead?: (head: Extract<TunnelMessage, { k: "head" }>) => void;
  onChunk?: (chunk: Extract<TunnelMessage, { k: "chunk" }>) => void;
  onError: (message: string) => void;
  onPair?: (credential: string | null) => void;
  socket?: TunnelSocket;
}

export class TunnelSession {
  readonly deviceId: string;
  readonly wsGzip: boolean;
  closed = false;
  readonly #channel: TunnelChannel;
  readonly #streams = new Map<string, PendingStream>();
  readonly #onClosed: () => void;
  #nextId = 1;

  constructor(deviceId: string, makeChannel: (session: TunnelSession) => TunnelChannel, onClosed: () => void, wsGzip = false) {
    this.deviceId = deviceId;
    this.wsGzip = wsGzip;
    this.#channel = makeChannel(this);
    this.#onClosed = onClosed;
  }

  get channel(): TunnelChannel {
    return this.#channel;
  }

  lastUsed(): number {
    return this.#channel.lastUsed;
  }

  /** 经隧道向对端的 T3 或 tty7 发一次 HTTP 请求。路径是以单 `/` 开头的绝对路径（带查询串）。 */
  async fetch(path: string, init: { method: string; headers: Headers2; body?: Uint8Array; target?: TunnelTarget }): Promise<Response> {
    if (this.closed) throw new Error("隧道已关闭");
    const id = String(this.#nextId++);
    return new Promise<Response>((resolve, reject) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let started = false;
      const timeoutMsg = init.target === "tty7" ? "对端终端服务响应超时" : "对端 T3 响应超时";
      const timer = setTimeout(() => fail(timeoutMsg), HEAD_TIMEOUT_MS);
      const fail = (message: string): void => {
        clearTimeout(timer);
        this.#streams.delete(id);
        if (started) {
          try {
            controller.error(new Error(message));
          } catch {
            // 流已经结束。
          }
        } else {
          reject(new Error(message));
        }
      };
      this.#streams.set(id, {
        onError: fail,
        onHead: (head) => {
          clearTimeout(timer);
          started = true;
          const headers = new Headers();
          for (const [name, value] of head.headers) headers.append(name, value);
          const noBody = head.status === 204 || head.status === 205 || head.status === 304 || (head.status >= 100 && head.status < 200);
          const body = noBody
            ? null
            : new ReadableStream<Uint8Array>({
                start: (c) => {
                  controller = c;
                },
                cancel: () => {
                  this.#streams.delete(id);
                },
              });
          resolve(new Response(body !== null && head.enc === "gzip" ? body.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : body, { status: head.status, statusText: head.statusText, headers }));
        },
        onChunk: (chunk) => {
          if (chunk.body !== "") {
            try {
              controller?.enqueue(new Uint8Array(Buffer.from(chunk.body, "base64")));
            } catch {
              // 读取方已取消。
            }
          }
          if (chunk.end) {
            this.#streams.delete(id);
            try {
              controller?.close();
            } catch {
              // 已经关了。
            }
          }
        },
      });
      void this.#sendRequest(id, path, init).catch((error: unknown) => fail(error instanceof Error ? error.message : "隧道发送失败"));
    });
  }

  async #sendRequest(id: string, path: string, init: { method: string; headers: Headers2; body?: Uint8Array; target?: TunnelTarget }): Promise<void> {
    const parts = init.body && init.body.length > 0 ? [...chunks(init.body)] : [];
    const first = parts[0];
    await this.#channel.post({
      k: "req",
      id,
      method: init.method,
      path,
      headers: init.headers,
      ...(first ? { body: b64(first) } : {}),
      end: parts.length <= 1,
      ...(init.target !== undefined ? { target: init.target } : {}),
    });
    const pipeline = new Pipeline();
    for (let index = 1; index < parts.length; index += 1) {
      await pipeline.post(() => this.#channel.post({ k: "body", id, body: b64(parts[index] as Uint8Array), end: index === parts.length - 1 }));
    }
    await pipeline.flush();
  }

  /** 经隧道打开对端 T3 或 tty7 的 WebSocket。 */
  socket(path: string, headers: Headers2, target?: TunnelTarget): TunnelSocket {
    const id = String(this.#nextId++);
    const socket = new TunnelSocket(
      id,
      (message) => (this.closed ? Promise.reject(new Error("隧道已关闭")) : this.#channel.post(message)),
      this.wsGzip,
    );
    this.#streams.set(id, { socket, onError: (message) => socket._failed(message) });
    void this.#channel
      .post({ k: "ws-open", id, path, headers, ...(target !== undefined ? { target } : {}) })
      .catch((error: unknown) => socket._failed(error instanceof Error ? error.message : undefined));
    return socket;
  }

  /** 向对端要一次性的浏览器配对凭据（由对端本机签发）。 */
  async pair(): Promise<string | null> {
    if (this.closed) return null;
    const id = String(this.#nextId++);
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#streams.delete(id);
        resolve(null);
      }, 15_000);
      this.#streams.set(id, {
        onError: () => {
          clearTimeout(timer);
          resolve(null);
        },
        onPair: (credential) => {
          clearTimeout(timer);
          this.#streams.delete(id);
          resolve(credential);
        },
      });
      void this.#channel.post({ k: "pair", id }).catch(() => {
        clearTimeout(timer);
        this.#streams.delete(id);
        resolve(null);
      });
    });
  }

  handle(message: TunnelMessage): void {
    if (message.k === "bye") {
      this.close(false);
      return;
    }
    const stream = this.#streams.get(message.id);
    if (!stream) return;
    switch (message.k) {
      case "head":
        stream.onHead?.(message);
        return;
      case "chunk":
        stream.onChunk?.(message);
        return;
      case "err":
        this.#streams.delete(message.id);
        stream.onError(message.message);
        return;
      case "ws-ok":
        stream.socket?._opened();
        return;
      case "ws-msg":
        stream.socket?._message(message);
        return;
      case "ws-close":
        this.#streams.delete(message.id);
        stream.socket?._closed(message.code, message.reason);
        return;
      case "pair-res":
        stream.onPair?.(message.credential);
        return;
      default:
        return;
    }
  }

  close(notify = true): void {
    if (this.closed) return;
    this.closed = true;
    if (notify) void this.#channel.post({ k: "bye" }).catch(() => undefined);
    for (const stream of this.#streams.values()) stream.onError("隧道已关闭");
    this.#streams.clear();
    this.#onClosed();
  }
}

export interface TunnelClientOptions {
  /** 向对端发签名指令（hub.dispatch）。 */
  dispatch(to: string, kind: string, args: unknown, options?: { timeoutMs?: number }): Promise<CommandOutcome>;
  send: Send;
  /** 中转状态里这台设备的身份公钥。 */
  peerKey(deviceId: string): string | undefined;
  pins: PeerPins;
  deviceId: string;
}

export class TunnelClient {
  readonly #options: TunnelClientOptions;
  readonly #sessions = new Map<string, TunnelSession>();
  readonly #opening = new Map<string, Promise<TunnelSession>>();
  readonly #bySid = new Map<string, TunnelSession>();
  #sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(options: TunnelClientOptions) {
    this.#options = options;
  }

  /** 到某台设备的隧道；已有可用的就复用，没有就握手新建。 */
  session(deviceId: string): Promise<TunnelSession> {
    const existing = this.#sessions.get(deviceId);
    if (existing && !existing.closed) return Promise.resolve(existing);
    const pending = this.#opening.get(deviceId);
    if (pending) return pending;
    const opening = this.#open(deviceId).finally(() => this.#opening.delete(deviceId));
    this.#opening.set(deviceId, opening);
    return opening;
  }

  onFrame(from: string, sid: string, data: string): void {
    const session = this.#bySid.get(`${from}\0${sid}`);
    session?.channel.receive(data);
  }

  closeAll(): void {
    for (const session of [...this.#sessions.values()]) session.close(false);
  }

  async #open(deviceId: string): Promise<TunnelSession> {
    const sid = randomBytes(12).toString("base64url");
    const ephemeral = newTunnelEphemeral();
    const outcome = await this.#options.dispatch(
      deviceId,
      TUNNEL_OPEN_KIND,
      { sid, epk: ephemeral.publicKey, caps: [TUNNEL_WS_GZIP_CAP] },
      { timeoutMs: OPEN_TIMEOUT_MS },
    );
    if (!outcome.ok) throw new Error(outcome.error);
    const result = outcome.result as { epk?: unknown; sig?: unknown; caps?: unknown } | null;
    if (typeof result?.epk !== "string" || typeof result.sig !== "string") throw new Error("对端的握手应答不合法");
    const peerCaps = Array.isArray(result.caps) ? result.caps.filter((cap): cap is string => typeof cap === "string") : [];
    const wsGzip = peerCaps.includes(TUNNEL_WS_GZIP_CAP);
    const publicKey = await this.#options.pins.resolve(deviceId, this.#options.peerKey(deviceId));
    const transcript = tunnelTranscript({
      sid,
      initiator: this.#options.deviceId,
      responder: deviceId,
      initiatorKey: ephemeral.publicKey,
      responderKey: result.epk,
    });
    if (!verifyTunnelTranscript(publicKey, transcript, result.sig)) throw new Error("对端的握手签名不对，已拒绝连接");
    const cipher = deriveTunnelCipher({ privateKey: ephemeral.privateKey, peerPublicKey: result.epk, sid, role: "initiator" });
    const key = `${deviceId}\0${sid}`;
    const session = new TunnelSession(
      deviceId,
      (self) =>
        new TunnelChannel(
          cipher,
          (data) => this.#options.send(deviceId, sid, data),
          (message) => self.handle(message),
          () => self.close(false),
        ),
      () => {
        if (this.#sessions.get(deviceId) === session) this.#sessions.delete(deviceId);
        this.#bySid.delete(key);
      },
      wsGzip,
    );
    this.#sessions.set(deviceId, session);
    this.#bySid.set(key, session);
    this.#startSweeper();
    return session;
  }

  #startSweeper(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => {
      const now = Date.now();
      for (const session of [...this.#sessions.values()]) {
        if (now - session.lastUsed() > IDLE_MS) session.close();
      }
      if (this.#sessions.size === 0 && this.#sweeper) {
        clearInterval(this.#sweeper);
        this.#sweeper = null;
      }
    }, 60_000);
    (this.#sweeper as { unref?: () => void }).unref?.();
  }
}
