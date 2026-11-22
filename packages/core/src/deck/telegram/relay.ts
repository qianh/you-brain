import type { TelegramMessage } from "./api.js";

/**
 * 连 U-Brain Telegram 中转（services/telegram-relay，部署在 Cloudflare）的客户端。
 * 多台设备共用一个 Bot 时，只有中转收 Telegram 的消息，再按设备分发；设备只连一条出站 WebSocket，
 * 不需要公网地址。帧格式见 services/telegram-relay/src/core.ts。
 */

export interface TelegramRelayDevice {
  id: string;
  name: string;
  online: boolean;
  enrolled?: boolean;
  publicKey?: string;
  dispatch?: unknown;
}

export interface TelegramRelayState {
  bot: { username: string; name: string } | null;
  bound: { name: string } | null;
  devices: TelegramRelayDevice[];
}

export interface DispatchRelayFrame {
  t: "cmd" | "cmdres" | "event";
  [k: string]: unknown;
}

export interface EnrollRelayInput {
  code: string;
  deviceId: string;
  name: string;
  publicKey: string;
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
  /** 过渡期共享密钥；若同时提供 `token`，优先用 `token`。 */
  key?: string;
  /** 入网后的设备专属令牌；有则 `Authorization: Bearer <token>`。 */
  token?: string;
  deviceId: string;
  name: string;
  onState(state: TelegramRelayState): void;
  onMessage(message: TelegramMessage): void;
  /** 本机被配成路由设备时，中转把「没引用的消息 + 候选推送」交给这里判断。 */
  onRoute?(message: TelegramMessage, candidates: TelegramRouteCandidate[]): void;
  onConnection(connection: "connecting" | "ok" | "error", error: string | null): void;
  onDispatchFrame?(frame: DispatchRelayFrame): void;
  socket?: RelaySocketFactory;
  retryMs?: readonly number[];
  pingMs?: number;
  requestTimeoutMs?: number;
}

/** 中转给路由设备的候选：最近推送过的一条提醒。 */
export interface TelegramRouteCandidate {
  /** 那条推送的 Telegram 消息 id（forward 的目标）。 */
  id: number;
  deviceId: string;
  deviceName: string;
  preview: string;
  at: number;
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

function redactSecret(text: string, secret: string): string {
  let out = text.replace(/ubd_[A-Za-z0-9_-]+/g, "[已隐藏]");
  if (secret !== "") out = out.split(secret).join("[已隐藏]");
  return out;
}

function enrollErrorMessage(status: number, serverError: string): string {
  const lower = serverError.toLowerCase();
  switch (status) {
    case 400:
      if (serverError.includes("公钥") || lower.includes("publickey") || lower.includes("public key")) {
        return "公钥不合法，无法入网";
      }
      if (serverError.includes("邀请码") || lower.includes("code") || lower.includes("invite")) {
        return "邀请码无效或已过期";
      }
      if (serverError.includes("设备") || lower.includes("device")) {
        return "设备信息不合法，无法入网";
      }
      return "入网请求参数不合法（公钥或设备信息有误）";
    case 401:
      return "邀请码无效或已过期";
    case 403:
      if (serverError.includes("吊销") || lower.includes("revok")) {
        return "这台设备已被中转吊销，无法入网";
      }
      return "邀请码无效、已过期或已作废";
    case 409:
      return "设备已入网，如需重新入网请先在中转吊销该设备";
    case 429:
      return "尝试次数过多，请稍后重试或重新生成邀请码";
    default:
      return `中转入网失败（HTTP ${status}）`;
  }
}

/** 兑换一次性邀请码入网：上报设备公钥，换取专属设备令牌。错误信息不包含邀请码或令牌。 */
export async function enrollRelay(
  url: string,
  input: EnrollRelayInput,
  fetchImpl: RelayFetch = fetch,
): Promise<{ token: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${url}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        deviceId: input.deviceId,
        name: input.name,
        publicKey: input.publicKey,
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (error) {
    const detail = redactSecret(error instanceof Error ? error.message : String(error), input.code);
    throw new Error(`连不上中转：${detail}`);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    const serverError = typeof body.error === "string" ? body.error.trim() : "";
    throw new Error(enrollErrorMessage(response.status, serverError));
  }
  const body = (await response.json().catch(() => ({}))) as { token?: unknown };
  if (typeof body.token !== "string" || body.token.trim() === "") {
    throw new Error("中转没有返回有效的设备令牌");
  }
  return { token: body.token.trim() };
}

/** 已入网的设备凭自己的令牌向中转要一个一次性邀请码（写进云盘给同账号的新设备用）。 */
export async function requestRelayInvite(
  url: string,
  token: string,
  fetchImpl: RelayFetch = fetch,
): Promise<{ code: string; expiresAt: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`${url}/invite`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(`连不上中转：${redactSecret(error instanceof Error ? error.message : String(error), token)}`);
  }
  const body = (await response.json().catch(() => ({}))) as { code?: unknown; expiresAt?: unknown; error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" && body.error ? body.error : `中转拒绝了邀请码申请（${response.status}）`);
  }
  if (typeof body.code !== "string" || typeof body.expiresAt !== "string") throw new Error("中转没有返回有效的邀请码");
  return { code: body.code, expiresAt: body.expiresAt };
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
      const credential = this.#options.token ? this.#options.token : (this.#options.key ?? "");
      socket = (this.#options.socket ?? defaultSocket)(`${base}/connect?${query}`, { Authorization: `Bearer ${credential}` });
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
      if (event.code === 4001) {
        this.#revoked("这台设备已被中转吊销，请重新入网");
        return;
      }
      if (event.code === 4000) {
        this.#lost("同一台设备在别处又连上了中转");
        return;
      }
      this.#lost(opened ? "和中转的连接断开了" : "连不上中转（地址、密钥或网络有问题）");
    };
    socket.addEventListener("close", closed);
    socket.addEventListener("error", () => closed({}));
  }

  #revoked(reason: string): void {
    const wasStopped = this.#stopped;
    this.#stopped = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    this.#teardown();
    this.#rejectAll(reason);
    if (!wasStopped) this.#options.onConnection("error", reason);
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
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.t === "state") {
      const devices: TelegramRelayDevice[] = Array.isArray(frame.devices)
        ? frame.devices
            .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
            .map((item) => ({
              id: typeof item.id === "string" ? item.id : "",
              name: typeof item.name === "string" ? item.name : "",
              online: item.online === true,
              ...(typeof item.enrolled === "boolean" ? { enrolled: item.enrolled } : {}),
              ...(typeof item.publicKey === "string" ? { publicKey: item.publicKey } : {}),
              ...(item.dispatch !== undefined ? { dispatch: item.dispatch } : {}),
            }))
        : [];
      this.#options.onState({
        bot: (frame.bot as TelegramRelayState["bot"]) ?? null,
        bound: (frame.bound as TelegramRelayState["bound"]) ?? null,
        devices,
      });
    } else if (frame.t === "message" && frame.message && typeof frame.message === "object") {
      this.#options.onMessage(frame.message as TelegramMessage);
    } else if (frame.t === "route" && frame.message && typeof frame.message === "object" && Array.isArray(frame.candidates)) {
      const candidates = (frame.candidates as Array<Record<string, unknown>>).flatMap((item) =>
        typeof item.id === "number" && typeof item.deviceId === "string" && typeof item.preview === "string"
          ? [
              {
                id: item.id,
                deviceId: item.deviceId,
                deviceName: typeof item.deviceName === "string" ? item.deviceName : "",
                preview: item.preview,
                at: typeof item.at === "number" ? item.at : 0,
              },
            ]
          : [],
      );
      this.#options.onRoute?.(frame.message as TelegramMessage, candidates);
    } else if (frame.t === "res" && typeof frame.id === "string") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      this.#pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok === true) pending.resolve(frame.result);
      else pending.reject(new Error(typeof frame.error === "string" ? frame.error : "中转处理失败"));
    } else if (frame.t === "cmd" || frame.t === "cmdres" || frame.t === "event") {
      try {
        const res: unknown = this.#options.onDispatchFrame?.(frame as DispatchRelayFrame);
        if (res && typeof (res as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(res).catch(() => undefined);
        }
      } catch {
        // 派活帧处理异常不影响连接。
      }
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

  /** 路由设备判断完：把这条消息当作「回复了 target 那条推送」转给那条推送所属的设备。 */
  async forward(message: TelegramMessage, target: number): Promise<void> {
    await this.request("forward", { message, target });
  }
}
