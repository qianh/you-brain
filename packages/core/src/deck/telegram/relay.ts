import type { TelegramMessage } from "./api.js";

/**
 * 连 U-Brain Telegram 中转（services/telegram-relay，部署在 Cloudflare）的客户端。
 * 多台设备共用一个 Bot 时，只有中转收 Telegram 的消息，再按设备分发；设备只连一条出站 WebSocket，
 * 不需要公网地址。帧格式见 services/telegram-relay/src/core.ts。
 */

export interface TelegramRelayState {
  bot: { username: string; name: string } | null;
  bound: { name: string } | null;
  devices: Array<{ id: string; name: string; online: boolean }>;
}

export interface RelaySocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown; code?: number }) => void): void;
}

export type RelaySocketFactory = (url: string, headers: Record<string, string>) => RelaySocketLike;
export type RelayFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TelegramRelayClientOptions {
  url: string;
  key: string;
  deviceId: string;
  name: string;
  onState(state: TelegramRelayState): void;
  onMessage(message: TelegramMessage): void;
  onConnection(connection: "connecting" | "ok" | "error", error: string | null): void;
  socket?: RelaySocketFactory;
  retryMs?: readonly number[];
  pingMs?: number;
  requestTimeoutMs?: number;
}

const DEFAULT_RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
const DEFAULT_PING_MS = 30_000;
const OPEN = 1;

/** 用户填的地址：`https://xxx.workers.dev`（末尾斜杠可有可无）。 */
export function normalizeRelayUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("中转地址不对，应形如 https://u-brain-telegram-relay.你的子域.workers.dev");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("中转地址必须是 https://");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function defaultSocket(url: string, headers: Record<string, string>): RelaySocketLike {
  // Bun 的 WebSocket 支持自定义请求头（浏览器不支持），密钥走 Authorization，不进地址。
  const Ctor = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => RelaySocketLike;
  return new Ctor(url, { headers });
}

/** 保存设置前检验地址和密钥：401 就是密钥不对。 */
export async function checkRelay(url: string, key: string, fetchImpl: RelayFetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`${url}/check`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(`连不上中转：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401) throw new Error("中转不认这个密钥（应与部署时的 RELAY_KEY 一致）");
  if (!response.ok) throw new Error(`中转返回 HTTP ${response.status}，请确认地址是部署出来的 workers.dev 地址`);
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; botConfigured?: boolean };
  if (body.ok !== true) throw new Error("这个地址不像 U-Brain 中转");
  if (body.botConfigured !== true) throw new Error("中转还没设置 BOT_TOKEN（wrangler secret put BOT_TOKEN）");
}

export class TelegramRelayClient {
  readonly #options: TelegramRelayClientOptions;
  #socket: RelaySocketLike | null = null;
  #stopped = true;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;
  #lastSeen = 0;
  #nextId = 1;
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(options: TelegramRelayClientOptions) {
    this.#options = options;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    this.#teardown();
    this.#rejectAll("已断开中转");
  }

  #teardown(): void {
    if (this.#ping !== null) clearInterval(this.#ping);
    this.#ping = null;
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close(1000, "bye");
    } catch {
      // 已经关了。
    }
  }

  #rejectAll(reason: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.#pending.delete(id);
    }
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#options.onConnection("connecting", null);
    const base = this.#options.url.replace(/^http/, "ws");
    const query = new URLSearchParams({ device: this.#options.deviceId, name: this.#options.name });
    let socket: RelaySocketLike;
    try {
      socket = (this.#options.socket ?? defaultSocket)(`${base}/connect?${query}`, { Authorization: `Bearer ${this.#options.key}` });
    } catch (error) {
      this.#lost(error instanceof Error ? error.message : String(error));
      return;
    }
    this.#socket = socket;
    let opened = false;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      opened = true;
      this.#failures = 0;
      this.#lastSeen = Date.now();
      this.#options.onConnection("ok", null);
      const pingMs = this.#options.pingMs ?? DEFAULT_PING_MS;
      this.#ping = setInterval(() => {
        // 两个心跳周期都没收到任何东西：连接已经死了（睡眠、换网络），重连。
        if (Date.now() - this.#lastSeen > pingMs * 2.5) {
          this.#lost("中转连接超时");
          return;
        }
        try {
          socket.send("ping");
        } catch {
          this.#lost("中转连接已断开");
        }
      }, pingMs);
      (this.#ping as { unref?: () => void }).unref?.();
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.#lastSeen = Date.now();
      if (typeof event.data === "string") this.#frame(event.data);
    });
    const closed = (event: { code?: number }) => {
      if (this.#socket !== socket) return;
      if (event.code === 4000) {
        this.#lost("同一台设备在别处又连上了中转");
        return;
      }
      this.#lost(opened ? "和中转的连接断开了" : "连不上中转（地址、密钥或网络有问题）");
    };
    socket.addEventListener("close", closed);
    socket.addEventListener("error", () => closed({}));
  }

  #lost(reason: string): void {
    this.#teardown();
    this.#rejectAll(reason);
    if (this.#stopped) return;
    this.#options.onConnection("error", reason);
    const retry = this.#options.retryMs ?? DEFAULT_RETRY_MS;
    const wait = retry[Math.min(this.#failures, retry.length - 1)]!;
    this.#failures += 1;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, wait);
    (this.#retry as { unref?: () => void }).unref?.();
  }

  #frame(raw: string): void {
    if (raw === "pong") return;
    let frame: { t?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown; message?: unknown } & Partial<TelegramRelayState>;
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    if (frame.t === "state") {
      this.#options.onState({ bot: frame.bot ?? null, bound: frame.bound ?? null, devices: frame.devices ?? [] });
    } else if (frame.t === "message" && frame.message && typeof frame.message === "object") {
      this.#options.onMessage(frame.message as TelegramMessage);
    } else if (frame.t === "res" && typeof frame.id === "string") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok === true) pending.resolve(frame.result);
      else pending.reject(new Error(typeof frame.error === "string" ? frame.error : "中转处理失败"));
    }
  }

  request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) return Promise.reject(new Error("还没连上中转"));
    const id = String(this.#nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("中转没有响应"));
      }, this.#options.requestTimeoutMs ?? 20_000);
      (timer as { unref?: () => void }).unref?.();
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        socket.send(JSON.stringify({ t: "req", id, op, ...params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 发消息；push 为真表示这是一条提醒（中转记下归属，手机回复它就转回本机）。返回 Telegram 消息 id。 */
  async send(text: string, options: { replyTo?: number; push?: boolean } = {}): Promise<number> {
    const result = await this.request<{ messageId: number }>("send", {
      text,
      ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
      ...(options.push ? { push: true } : {}),
    });
    return result.messageId;
  }
}
