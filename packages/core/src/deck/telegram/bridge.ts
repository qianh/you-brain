import { randomInt, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { z } from "zod";

import type { SecretStore } from "../../auth/secret-store.js";
import type { DeviceIdentity } from "../../dispatch/identity.js";
import { YouBrainError } from "../../domain/errors.js";
import { readJsonFile, writeJsonFile } from "../../daemon/local-state.js";
import type { SessionNotice, SessionNoticeDismissInput, SessionNoticeList } from "../session-notices.js";
import type { Tty7SendInput, Tty7SessionsView } from "../tty7.js";
import {
  TELEGRAM_TOKEN_PATTERN,
  TelegramApi,
  TelegramApiError,
  type TelegramFetch,
  type TelegramMessage,
} from "./api.js";
import {
  TelegramRelayClient,
  checkRelay,
  enrollRelay,
  normalizeRelayUrl,
  type DispatchRelayFrame,
  type RelayFetch,
  type RelaySocketFactory,
  type TelegramRelayState,
  type TelegramRouteCandidate,
} from "./relay.js";
import { encodeRelayInvite } from "./invite.js";
import {
  PENDING_CHOICE_TTL_MS,
  formatChoiceList,
  parseChoiceReply,
  type TelegramRouteJudge,
} from "./router.js";

/**
 * Telegram 桥：把「终端会话在等你回复」推到绑定的 Telegram 私聊；
 * 在 Telegram 里回复某条提醒，文字就输入到对应的 tty7 会话（相当于在终端里打字加回车）。
 * 只认绑定的那个私聊；不提供任意命令。
 * 两种模式：直连（本机 long polling，一个 Bot 只能一台设备用）；中转（多台设备共用一个 Bot，
 * Telegram 只连 Cloudflare 上的中转，本机连一条出站 WebSocket，见 services/telegram-relay）。
 */

export interface TelegramStatus {
  /** 钥匙串里有 Bot Token。 */
  configured: boolean;
  bot: { username: string; name: string } | null;
  connection: "off" | "connecting" | "ok" | "error";
  error: string | null;
  bound: { name: string } | null;
  notificationsEnabled: boolean;
  pairing: { code: string; link: string; expiresAt: string } | null;
  /** 用中转时：地址、本机在中转里的名字、中转见过的设备。 */
  relay: { url: string; name: string; devices: Array<{ name: string; online: boolean; self: boolean }> } | null;
}

export type TelegramAction =
  | { action: "set-token"; token: string }
  | { action: "clear-token" }
  | { action: "pair" }
  | { action: "unbind" }
  | { action: "test" }
  | { action: "set-notifications"; enabled: boolean }
  | { action: "set-relay"; url: string; key: string; name?: string | undefined }
  | { action: "enroll-relay"; url: string; code: string; name?: string | undefined }
  | { action: "clear-relay" };

export interface TelegramDispatchLink {
  request<T>(op: string, params?: Record<string, unknown>): Promise<T>;
}

export interface TelegramDispatchPort {
  attach(link: TelegramDispatchLink | null): void;
  onFrame(frame: DispatchRelayFrame): void;
  setState(state: TelegramRelayState): void;
  /** 向已派出的会话追加一条消息（手机上直接回复派活推送时用）。 */
  followup?(dispatchId: string, prompt: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface TelegramDispatchIdentity {
  ensure(): Promise<{ publicKey: string; privateKey: string }>;
}

export interface TelegramBridgeOptions {
  /** `<dataDir>/deck/telegram.json`：绑定的私聊与收消息进度，不含 Token。 */
  configPath: string;
  token: SecretStore;
  /** 中转的设备连接密钥；不传就不能用中转。 */
  relayKey?: SecretStore;
  /** 中转入网后的设备专属令牌；有则优先于 relayKey 使用。 */
  relayToken?: SecretStore;
  /** 跨设备派活中枢接口（结构类型，避免与 dispatch/hub 循环依赖）。 */
  dispatch?: TelegramDispatchPort;
  /** 跨设备派活本机身份（入网时提供公钥）。 */
  dispatchIdentity?: DeviceIdentity;
  /** 本机被中转配成路由设备时，按内容判断「没引用的消息」回的是哪条推送；缺省视为拿不准，直接让用户选。 */
  routeJudge?: TelegramRouteJudge;
  notices(): SessionNoticeList;
  sessions(): Promise<Tty7SessionsView>;
  send(input: Tty7SendInput): Promise<void>;
  dismiss(input: SessionNoticeDismissInput): void;
  /** 状态变了（连接、绑定），daemon 借此通知网页刷新。 */
  onChange?(): void;
  fetch?: TelegramFetch;
  relayFetch?: RelayFetch;
  relaySocket?: RelaySocketFactory;
  /** 本机在中转里的稳定设备 ID；未配置过中转时用它作为 relay.deviceId。 */
  deviceId?: string;
  /** 本机在中转里的默认名字（默认主机名）。 */
  deviceName?: string;
  now?(): number;
  /** long polling 每次挂起的秒数。 */
  pollTimeoutSec?: number;
  /** 出错后的重试间隔，逐次加长，用完停在最后一档。 */
  retryMs?: readonly number[];
}

const StoredSchema = z.object({
  botId: z.number().int().nullable().default(null),
  chatId: z.number().int().nullable().default(null),
  chatName: z.string().nullable().default(null),
  offset: z.number().int().nonnegative().default(0),
  notificationsEnabled: z.boolean().default(false),
  relay: z
    .object({ url: z.string(), deviceId: z.string(), name: z.string() })
    .nullable()
    .default(null),
});
type Stored = z.infer<typeof StoredSchema>;

const EMPTY_BINDING = { botId: null, chatId: null, chatName: null, offset: 0 };
const EMPTY: Stored = { ...EMPTY_BINDING, relay: null, notificationsEnabled: false };
const RELAY_KEY_MIN = 16;

function defaultDeviceName(): string {
  return hostname().replace(/\.local$/, "").slice(0, 40) || "U-Brain";
}

/** 中转返回的错误按 Telegram 错误报（HTTP 502），与直连一致。 */
function relayError(error: unknown): Error {
  if (error instanceof TelegramApiError || error instanceof YouBrainError) return error;
  return new TelegramApiError(error instanceof Error ? error.message : String(error), null);
}
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_MAX_FAILURES = 5;
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SENT_KEPT = 200;
const BODY_MAX = 3_000;
const DEFAULT_RETRY_MS = [3_000, 10_000, 30_000, 60_000] as const;
/** 直接发消息时，最近会话超过这么久就不再默认发给它，免得打进早已无关的会话。 */
export const RECENT_TARGET_TTL_MS = 2 * 60 * 60_000;

/** 推送过的提醒对应的会话：tty7 终端会话或 T3 会话。 */
type SentNotice =
  | { kind: "tty7"; pane: number; cwd: string; name: string }
  | { kind: "t3"; threadId: string; name: string }
  /** 跨设备派活出去的会话：回复经派活中枢追加给目标设备上的那个会话。 */
  | { kind: "dispatch"; dispatchId: string; name: string };

/** T3 会话的读写（daemon 在 T3 适配器就绪后挂上）。 */
export interface TelegramT3Port {
  /** 发一条消息：空闲就开始新一轮，执行中就排队；返回 T3 的投递结果（started / queued …）。 */
  send(threadId: string, text: string, requestId: string): Promise<string>;
  /** 最近一次监视看到的状态；不知道时为 null。 */
  status(threadId: string): string | null;
  /** 最后一条助手回答，推送正文用。 */
  answer(threadId: string): Promise<string>;
}

export interface TelegramT3Notice {
  threadId: string;
  title: string;
  kind: "done" | "waiting" | "failed";
  link: string | null;
}

export interface TelegramDispatchNotice {
  /** 派活 ID；带上才能把这条推送登记成「最近的会话」，让手机上直接回复进到被派的会话。 */
  dispatchId?: string;
  deviceName: string;
  title: string;
  kind: "done" | "waiting" | "failed";
  body?: string;
  link?: string | null;
}

export function dispatchNoticeText(notice: TelegramDispatchNotice): string {
  const trimmed = (notice.body ?? "").trim();
  const clipped = trimmed.length > BODY_MAX ? `${trimmed.slice(0, BODY_MAX)}…` : trimmed;
  const head =
    notice.kind === "done"
      ? `✅ 🛰 ${notice.deviceName}「${notice.title}」做完了`
      : notice.kind === "waiting"
        ? `⏳ 🛰 ${notice.deviceName}「${notice.title}」在等你处理授权或提问`
        : `❌ 🛰 ${notice.deviceName}「${notice.title}」执行失败`;
  return [head, ...(clipped ? ["", clipped] : []), ...(notice.link ? ["", `🔗 ${notice.link}`] : [])].join("\n");
}

export function t3NoticeText(notice: TelegramT3Notice, body: string): string {
  const trimmed = body.trim();
  const clipped = trimmed.length > BODY_MAX ? `${trimmed.slice(0, BODY_MAX)}…` : trimmed;
  const head =
    notice.kind === "done"
      ? `✅ T3「${notice.title}」做完了`
      : notice.kind === "waiting"
        ? `⏳ T3「${notice.title}」在等你处理授权或提问`
        : `❌ T3「${notice.title}」执行失败`;
  const hint =
    notice.kind === "waiting"
      ? "授权和提问需要到 T3 里处理"
      : "↩️ 回复这条消息（或直接发消息），作为下一条指令发给这个 T3 会话";
  return [head, ...(clipped ? ["", clipped] : []), ...(notice.link ? ["", `🔗 ${notice.link}`] : []), "", hint].join("\n");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function displayName(message: TelegramMessage): string {
  const from = message.from;
  if (from?.username) return `@${from.username}`;
  return [from?.first_name, from?.last_name].filter(Boolean).join(" ") || String(message.chat.id);
}

/**
 * 推哪些提醒：「等你回复」都推；「已完成」只推 AI 会话（Claude、Codex 等，agent 非空）的——
 * AI 会话做完一轮就是在等下一条指令，普通脚本跑完不需要回复，推了只会吵。
 */
export function pushable(notice: Pick<SessionNotice, "kind" | "agent">): boolean {
  return notice.kind === "waiting" || (notice.kind === "done" && notice.agent !== null);
}

export function noticeText(kind: SessionNotice["kind"], title: string, body: string): string {
  const trimmed = body.trim();
  const clipped = trimmed.length > BODY_MAX ? `${trimmed.slice(0, BODY_MAX)}…` : trimmed;
  const head = kind === "waiting" ? `⏳ ${title}` : `✅ ${title}`;
  const hint = kind === "waiting" ? "↩️ 回复这条消息，文字会输入到这个会话" : "↩️ 回复这条消息，作为下一条指令发给这个会话";
  return [head, ...(clipped ? ["", clipped] : []), "", hint].join("\n");
}

export class TelegramBridge {
  readonly #options: TelegramBridgeOptions;
  #stored: Stored = { ...EMPTY };
  #saveChain: Promise<void> = Promise.resolve();
  #notificationRevision = 0;
  #api: TelegramApi | null = null;
  #bot: { id: number; username: string; name: string } | null = null;
  #connection: TelegramStatus["connection"] = "off";
  #error: string | null = null;
  #pair: { code: string; expiresAt: number; failures: number } | null = null;
  #loop: AbortController | null = null;
  #started = false;
  #cursor: { epoch: string; seq: number } | null = null;
  readonly #sent = new Map<number, SentNotice>();
  /** 直接发的消息（没回复某条提醒）发给它：最近推送过、或最近回复过的会话。 */
  #recent: { target: SentNotice; at: number } | null = null;
  /** 路由设备问过用户「是哪一条」之后，等用户回序号。 */
  #pendingChoice: { message: TelegramMessage; candidates: TelegramRouteCandidate[]; at: number } | null = null;
  #t3: TelegramT3Port | null = null;
  #pushChain: Promise<void> = Promise.resolve();
  #relay: TelegramRelayClient | null = null;
  #relayState: TelegramRelayState | null = null;
  #relayPair: { code: string; link: string; expiresAt: string } | null = null;

  constructor(options: TelegramBridgeOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #changed(): void {
    try {
      this.#options.onChange?.();
    } catch {
      // 通知网页失败不影响桥本身。
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    // 启动时已有的提醒不补推，只推之后新出现的。
    const list = this.#options.notices();
    this.#cursor = { epoch: list.epoch, seq: list.latest };
    this.#stored = await readJsonFile(this.#options.configPath, (value) => StoredSchema.parse(value), { ...EMPTY });
    const relay = this.#stored.relay;
    if (relay) {
      const relayToken = (await this.#options.relayToken?.get().catch(() => null))?.trim() ?? "";
      const relayKey = relayToken ? "" : ((await this.#options.relayKey?.get().catch(() => null))?.trim() ?? "");
      if (relayToken || relayKey) {
        if (this.#started) this.#runRelay(relay, relayToken ? { token: relayToken } : { key: relayKey });
        return;
      }
    }
    const token = (await this.#options.token.get().catch(() => null))?.trim() ?? "";
    if (token && this.#started) this.#run(token);
  }

  stop(): void {
    this.#started = false;
    this.#notificationRevision += 1;
    this.#loop?.abort();
    this.#loop = null;
    this.#api = null;
    this.#relay?.stop();
    this.#relay = null;
    this.#options.dispatch?.attach(null);
    this.#connection = "off";
  }

  status(): TelegramStatus {
    if (this.#relay && this.#stored.relay) return this.#relayStatus(this.#stored.relay);
    const pair = this.#pair && this.#pair.expiresAt > this.#now() ? this.#pair : null;
    return {
      configured: this.#api !== null,
      bot: this.#bot ? { username: this.#bot.username, name: this.#bot.name } : null,
      connection: this.#connection,
      error: this.#error,
      bound: this.#stored.chatId === null ? null : { name: this.#stored.chatName ?? String(this.#stored.chatId) },
      notificationsEnabled: this.#stored.notificationsEnabled,
      pairing:
        pair && this.#bot
          ? {
              code: pair.code,
              link: `https://t.me/${this.#bot.username}?start=${pair.code}`,
              expiresAt: new Date(pair.expiresAt).toISOString(),
            }
          : null,
      relay: null,
    };
  }

  #relayStatus(relay: NonNullable<Stored["relay"]>): TelegramStatus {
    const state = this.#relayState;
    const pair = this.#relayPair && Date.parse(this.#relayPair.expiresAt) > this.#now() && !state?.bound ? this.#relayPair : null;
    return {
      configured: true,
      bot: state?.bot ?? null,
      connection: this.#connection,
      error: this.#error,
      bound: state?.bound ?? null,
      notificationsEnabled: this.#stored.notificationsEnabled,
      pairing: pair,
      relay: {
        url: relay.url,
        name: relay.name,
        devices: (state?.devices ?? []).map((device) => ({
          name: device.name,
          online: device.online,
          self: device.id === relay.deviceId,
        })),
      },
    };
  }

  async action(input: TelegramAction): Promise<TelegramStatus> {
    if (input.action === "set-notifications") {
      if (input.enabled && !this.bound()) throw new YouBrainError("INVALID_INPUT", "还没有绑定 Telegram");
      await this.#save({ notificationsEnabled: input.enabled });
      this.#changed();
      return this.status();
    }
    if (input.action === "set-relay") {
      await this.#setRelay(input);
      this.#changed();
      return this.status();
    }
    if (input.action === "enroll-relay") {
      await this.#enrollRelay(input);
      this.#changed();
      return this.status();
    }
    if (input.action === "clear-relay") {
      await this.#clearRelay();
      this.#changed();
      return this.status();
    }
    if (this.#relay && input.action !== "set-token" && input.action !== "clear-token") {
      await this.#relayAction(this.#relay, input.action).catch((error: unknown) => {
        throw relayError(error);
      });
      this.#changed();
      return this.status();
    }
    switch (input.action) {
      case "set-token":
        if (this.#relay) throw new YouBrainError("INVALID_INPUT", "正在用中转：Bot Token 要设在中转里（wrangler secret put BOT_TOKEN），这里不用填");
        await this.#setToken(input.token.trim());
        break;
      case "clear-token":
        if (this.#relay) {
          await this.#options.token.delete();
          break;
        }
        this.#loop?.abort();
        this.#loop = null;
        this.#api = null;
        this.#bot = null;
        this.#pair = null;
        this.#connection = "off";
        this.#error = null;
        await this.#options.token.delete();
        await this.#save(EMPTY_BINDING);
        break;
      case "pair":
        if (!this.#api || !this.#bot) throw new YouBrainError("INVALID_INPUT", "请先填写 Bot Token");
        this.#pair = { code: this.#newCode(), expiresAt: this.#now() + PAIR_TTL_MS, failures: 0 };
        break;
      case "unbind":
        this.#pair = null;
        await this.#save({ chatId: null, chatName: null });
        this.#sent.clear();
        this.#recent = null;
        break;
      case "test": {
        const api = this.#api;
        const chatId = this.#stored.chatId;
        if (!api || chatId === null) throw new YouBrainError("INVALID_INPUT", "还没有绑定 Telegram");
        await api.sendMessage(chatId, "✅ U-Brain 测试消息：推送通道正常。");
        break;
      }
    }
    this.#changed();
    return this.status();
  }

  async #setToken(token: string): Promise<void> {
    if (!TELEGRAM_TOKEN_PATTERN.test(token)) throw new YouBrainError("INVALID_INPUT", "Bot Token 格式不对，应形如 123456789:AA…（从 @BotFather 复制）");
    const api = new TelegramApi(token, this.#options.fetch);
    const me = await api.getMe().catch((error: unknown) => {
      if (error instanceof TelegramApiError && (error.code === 401 || error.code === 404)) {
        throw new YouBrainError("INVALID_INPUT", "Telegram 不认这个 Bot Token，请到 @BotFather 重新复制");
      }
      throw error;
    });
    await this.#options.token.set(token);
    // 换了一个 Bot：原来的绑定和收消息进度都作废。
    if (this.#stored.botId !== me.id) await this.#save({ ...EMPTY_BINDING, botId: me.id });
    this.#pair = null;
    this.#run(token, me);
  }

  async #relayAction(relay: TelegramRelayClient, action: "pair" | "unbind" | "test"): Promise<void> {
    if (action === "pair") {
      this.#relayPair = await relay.request<{ code: string; link: string; expiresAt: string }>("pair");
    } else if (action === "unbind") {
      this.#relayPair = null;
      await relay.request("unbind");
      this.#sent.clear();
      this.#recent = null;
    } else {
      if (!this.#relayState?.bound) throw new YouBrainError("INVALID_INPUT", "还没有绑定 Telegram");
      await relay.send(`✅ U-Brain 测试消息：「${this.#stored.relay?.name ?? ""}」经中转推送正常。`);
    }
  }

  async #setRelay(input: { url: string; key: string; name?: string | undefined }): Promise<void> {
    const relayKey = this.#options.relayKey;
    if (!relayKey) throw new YouBrainError("INVALID_INPUT", "这个版本不支持中转");
    let url: string;
    try {
      url = normalizeRelayUrl(input.url);
    } catch (error) {
      throw new YouBrainError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
    }
    const key = input.key.trim();
    if (key.length < RELAY_KEY_MIN) throw new YouBrainError("INVALID_INPUT", `中转密钥至少 ${RELAY_KEY_MIN} 位，应与部署时的 RELAY_KEY 一致`);
    try {
      await checkRelay(url, key, this.#options.relayFetch);
    } catch (error) {
      throw new YouBrainError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
    }
    await relayKey.set(key);
    const name = input.name?.trim().slice(0, 40) || this.#stored.relay?.name || this.#options.deviceName || defaultDeviceName();
    const existingId = this.#stored.relay?.deviceId;
    const optionId = this.#options.deviceId;
    const deviceId =
      existingId && /^[A-Za-z0-9_-]{8,64}$/.test(existingId)
        ? existingId
        : optionId && /^[A-Za-z0-9_-]{8,64}$/.test(optionId)
          ? optionId
          : randomUUID();
    const relay = { url, name, deviceId };
    // 换到中转：本机不再自己收 Telegram 消息，直连的绑定作废（中转里另行绑定）。
    this.#loop?.abort();
    this.#loop = null;
    this.#api = null;
    this.#pair = null;
    this.#sent.clear();
    this.#recent = null;
    await this.#save({ chatId: null, chatName: null, relay });
    if (this.#started) this.#runRelay(relay, { key });
  }

  async #enrollRelay(input: { url: string; code: string; name?: string | undefined }): Promise<void> {
    const relayToken = this.#options.relayToken;
    const identity = this.#options.dispatchIdentity;
    if (!relayToken || !identity) throw new YouBrainError("INVALID_INPUT", "这个版本不支持入网");
    let url: string;
    try {
      url = normalizeRelayUrl(input.url);
    } catch (error) {
      throw new YouBrainError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
    }
    const code = input.code.trim();
    if (!code) throw new YouBrainError("INVALID_INPUT", "请填写邀请码");
    const name = input.name?.trim().slice(0, 40) || this.#stored.relay?.name || this.#options.deviceName || defaultDeviceName();
    const existingId = this.#stored.relay?.deviceId;
    const optionId = this.#options.deviceId;
    const deviceId =
      existingId && /^[A-Za-z0-9_-]{8,64}$/.test(existingId)
        ? existingId
        : optionId && /^[A-Za-z0-9_-]{8,64}$/.test(optionId)
          ? optionId
          : randomUUID();
    let publicKey: string;
    try {
      publicKey = (await identity.ensure()).publicKey;
    } catch (error) {
      throw new YouBrainError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
    }
    let token: string;
    try {
      token = (await enrollRelay(url, { code, deviceId, name, publicKey }, this.#options.relayFetch)).token;
    } catch (error) {
      throw new YouBrainError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
    }
    await relayToken.set(token);
    await this.#options.relayKey?.delete();
    const relay = { url, name, deviceId };
    // 换到中转：本机不再自己收 Telegram 消息，直连的绑定作废（中转里另行绑定）。
    this.#loop?.abort();
    this.#loop = null;
    this.#api = null;
    this.#pair = null;
    this.#sent.clear();
    this.#recent = null;
    await this.#save({ chatId: null, chatName: null, relay });
    if (this.#started) this.#runRelay(relay, { token });
  }

  async #clearRelay(): Promise<void> {
    this.#relay?.stop();
    this.#relay = null;
    this.#options.dispatch?.attach(null);
    this.#relayState = null;
    this.#relayPair = null;
    this.#connection = "off";
    this.#error = null;
    this.#sent.clear();
    this.#recent = null;
    await this.#options.relayKey?.delete();
    await this.#options.relayToken?.delete();
    await this.#save({ relay: null });
    // 还留着 Bot Token 就回到直连。
    const token = (await this.#options.token.get().catch(() => null))?.trim() ?? "";
    if (token && this.#started) this.#run(token);
  }

  #runRelay(relay: NonNullable<Stored["relay"]>, auth: { token?: string; key?: string }): void {
    if (this.#relay) {
      this.#relay.stop();
      this.#options.dispatch?.attach(null);
    }
    this.#connection = "connecting";
    this.#error = null;
    const client = new TelegramRelayClient({
      url: relay.url,
      ...(auth.token ? { token: auth.token } : {}),
      ...(auth.key ? { key: auth.key } : {}),
      deviceId: relay.deviceId,
      name: relay.name,
      onState: (state) => {
        if (this.#relay !== client) return;
        this.#relayState = state;
        if (state.bound) this.#relayPair = null;
        else {
          this.#sent.clear();
          this.#recent = null;
        }
        this.#options.dispatch?.setState(state);
        this.#changed();
      },
      onMessage: (message) => {
        if (this.#relay !== client) return;
        void this.#handleBound(message, message.text?.trim() ?? "").catch(() => undefined);
      },
      onRoute: (message, candidates) => {
        if (this.#relay !== client) return;
        void this.#handleRoute(client, message, candidates).catch((error: unknown) => {
          console.error(`[telegram] 路由处理失败：${error instanceof Error ? error.message : String(error)}`);
        });
      },
      onConnection: (connection, error) => {
        if (this.#relay !== client) return;
        this.#connection = connection;
        this.#error = error;
        if (connection === "ok") this.#options.dispatch?.attach(client);
        else this.#options.dispatch?.attach(null);
        this.#changed();
      },
      onDispatchFrame: (frame) => {
        if (this.#relay !== client) return;
        this.#options.dispatch?.onFrame(frame);
      },
      ...(this.#options.relaySocket ? { socket: this.#options.relaySocket } : {}),
      ...(this.#options.retryMs ? { retryMs: this.#options.retryMs } : {}),
    });
    this.#relay = client;
    client.start();
  }

  #newCode(): string {
    let code = "";
    for (let index = 0; index < 8; index += 1) code += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)];
    return code;
  }

  #save(patch: Partial<Stored>): Promise<void> {
    const write = this.#saveChain.then(async () => {
      const next = { ...this.#stored, ...patch };
      await writeJsonFile(this.#options.configPath, next);
      if (next.notificationsEnabled !== this.#stored.notificationsEnabled) this.#notificationRevision += 1;
      this.#stored = next;
    });
    this.#saveChain = write.catch(() => undefined);
    return write;
  }

  #run(token: string, me?: { id: number; username?: string; first_name?: string }): void {
    this.#loop?.abort();
    const controller = new AbortController();
    this.#loop = controller;
    const api = new TelegramApi(token, this.#options.fetch);
    this.#api = api;
    this.#connection = "connecting";
    this.#error = null;
    if (me) this.#bot = { id: me.id, username: me.username ?? "", name: me.first_name ?? "" };
    void this.#poll(api, controller.signal);
  }

  async #poll(api: TelegramApi, signal: AbortSignal): Promise<void> {
    const retry = this.#options.retryMs ?? DEFAULT_RETRY_MS;
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (!this.#bot) {
          const me = await api.getMe(signal);
          this.#bot = { id: me.id, username: me.username ?? "", name: me.first_name ?? "" };
          if (this.#stored.botId !== me.id) await this.#save({ ...EMPTY_BINDING, botId: me.id });
        }
        if (this.#connection !== "ok") {
          this.#connection = "ok";
          this.#error = null;
          this.#changed();
        }
        const updates = await api.getUpdates(this.#stored.offset, this.#options.pollTimeoutSec ?? 25, signal);
        failures = 0;
        if (signal.aborted) return;
        if (updates.length === 0) continue;
        // 先记下进度再处理：宁可漏处理一条，也不要重启后把旧回复再打进终端。
        const last = updates[updates.length - 1]!.update_id;
        await this.#save({ offset: last + 1 });
        for (const update of updates) {
          if (signal.aborted) return;
          if (update.message) await this.#handle(update.message).catch(() => undefined);
        }
      } catch (error) {
        if (signal.aborted) return;
        const code = error instanceof TelegramApiError ? error.code : null;
        this.#connection = "error";
        if (code === 401 || code === 404) {
          this.#error = "Bot Token 已失效，请重新填写";
          this.#changed();
          return;
        }
        this.#error =
          code === 409
            ? "另一个程序正在用这个 Bot 收消息（或设置了 webhook），两边会抢消息"
            : error instanceof Error
              ? error.message
              : String(error);
        this.#changed();
        await delay(retry[Math.min(failures, retry.length - 1)]!, signal);
        failures += 1;
      }
    }
  }

  async #reply(message: TelegramMessage, text: string): Promise<void> {
    if (this.#relay) {
      await this.#relay.send(text, { replyTo: message.message_id });
      return;
    }
    await this.#api?.sendMessage(message.chat.id, text, message.message_id);
  }

  /** 能不能推送：中转已绑定，或直连已绑定。 */
  #canPush(): boolean {
    if (!this.#started) return false;
    if (this.#relay) return this.#relayState?.bound != null;
    return this.#api !== null && this.#stored.chatId !== null;
  }

  /** 推一条提醒，返回 Telegram 消息 id（回复它就能找回这条提醒）。 */
  async #push(text: string): Promise<number> {
    if (this.#relay) return this.#relay.send(text, { push: true });
    const api = this.#api;
    const chatId = this.#stored.chatId;
    if (!api || chatId === null) throw new Error("还没有绑定 Telegram");
    return (await api.sendMessage(chatId, text)).message_id;
  }

  async #handle(message: TelegramMessage): Promise<void> {
    if (message.chat.type !== "private") return;
    const text = message.text?.trim() ?? "";
    const bound = this.#stored.chatId;
    if (bound === null || message.chat.id !== bound) {
      await this.#handleStranger(message, text, bound !== null);
      return;
    }
    await this.#handleBound(message, text);
  }

  /** 已绑定私聊发来的消息（直连已核对私聊；中转模式由中转核对后转来）。 */
  async #handleBound(message: TelegramMessage, text: string): Promise<void> {
    if (text.startsWith("/")) {
      await this.#reply(message, this.#helpText());
      return;
    }
    if (!text) {
      await this.#reply(message, "目前只支持文字。");
      return;
    }
    const replyTo = message.reply_to_message?.message_id;
    if (replyTo === undefined) {
      // 没指定提醒：发给最近推送过（或最近回复过）的会话；太久以前的不算。
      const recent = this.#recent;
      if (recent === null || this.#now() - recent.at > RECENT_TARGET_TTL_MS) {
        await this.#reply(message, this.#helpText());
        return;
      }
      await this.#deliver(message, recent.target, text);
      return;
    }
    const target = this.#sent.get(replyTo);
    if (!target) {
      await this.#reply(message, "这条消息不是可回复的提醒，或提醒已失效（U-Brain 重启过）。请回复最新的提醒，或到电脑上处理。");
      return;
    }
    await this.#deliver(message, target, text);
  }

  /**
   * 本机是路由设备：手机上没引用的消息先到这里。
   * 先看是不是在回「请选序号」；只有一条候选直接转；否则按内容判断；拿不准就列出来让用户选。
   */
  async #handleRoute(client: TelegramRelayClient, message: TelegramMessage, candidates: TelegramRouteCandidate[]): Promise<void> {
    const text = message.text?.trim() ?? "";
    if (!text) {
      await this.#reply(message, "目前只支持文字。");
      return;
    }
    const forward = async (original: TelegramMessage, candidate: TelegramRouteCandidate): Promise<void> => {
      try {
        await client.forward(original, candidate.id);
      } catch (error) {
        await this.#reply(message, `转发失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const pending = this.#pendingChoice;
    this.#pendingChoice = null;
    if (pending && this.#now() - pending.at <= PENDING_CHOICE_TTL_MS) {
      const index = parseChoiceReply(text, pending.candidates.length);
      if (index !== null) {
        await forward(pending.message, pending.candidates[index]!);
        return;
      }
    }

    let index: number | null = candidates.length === 1 ? 0 : null;
    if (index === null && candidates.length > 1) {
      console.log(`[telegram] 路由判断：${candidates.length} 个候选`);
      index = (await this.#options.routeJudge?.({ text, candidates, now: this.#now() }).catch(() => null)) ?? null;
      console.log(`[telegram] 路由判断结果：${index === null ? "拿不准" : index + 1}`);
    }
    const chosen = index === null ? undefined : candidates[index];
    if (chosen) {
      await forward(message, chosen);
      return;
    }
    this.#pendingChoice = { message, candidates, at: this.#now() };
    await this.#reply(message, formatChoiceList(candidates));
  }

  async #handleStranger(message: TelegramMessage, text: string, boundToOther: boolean): Promise<void> {
    // 已经绑了别人：一概不理，不暴露任何信息。
    if (boundToOther) return;
    const match = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (!match) return;
    const pair = this.#pair;
    const valid = pair !== null && pair.expiresAt > this.#now() && match[1]?.toUpperCase() === pair.code;
    if (!valid) {
      if (pair && match[1]) {
        pair.failures += 1;
        if (pair.failures >= PAIR_MAX_FAILURES) this.#pair = null;
      }
      await this.#reply(message, "绑定码无效或已过期。请在 U-Brain「设置 → 集成 → Telegram」里重新生成绑定链接。");
      return;
    }
    this.#pair = null;
    await this.#save({ chatId: message.chat.id, chatName: displayName(message) });
    this.#changed();
    await this.#reply(
      message,
      "✅ 已绑定 U-Brain。\n\n终端会话等你回复、或 AI 会话做完一轮时，会推送到这里；直接发消息会发给最近推送过来的会话，要指定别的会话就长按那条提醒选「回复」。",
    );
  }

  #helpText(): string {
    const waiting = this.#options
      .notices()
      .notices.filter((notice) => notice.status === "open" && pushable(notice))
      .map((notice) => `· ${notice.title}`);
    return [
      "直接发消息，会发给最近推送过来的那个会话；要发给别的会话，长按那条提醒选「回复」。",
      "",
      waiting.length > 0 ? `现在等你处理的会话：\n${waiting.join("\n")}` : "现在没有等你处理的会话。",
    ].join("\n");
  }

  async #deliver(message: TelegramMessage, target: SentNotice, text: string): Promise<void> {
    if (target.kind === "t3") {
      await this.#deliverT3(message, target, text);
      return;
    }
    if (target.kind === "dispatch") {
      await this.#deliverDispatch(message, target, text);
      return;
    }
    let view: Tty7SessionsView;
    try {
      view = await this.#options.sessions();
    } catch (error) {
      await this.#reply(message, `读取终端会话失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // pane 编号会被新会话复用，用目录一并核对，避免打进别的会话。
    const session = view.sessions.find((item) => item.pane === target.pane && item.cwd === target.cwd);
    if (!view.available || !session) {
      await this.#reply(message, `会话「${target.name}」已经关闭，没有发送。`);
      return;
    }
    if (session.status === "working") {
      await this.#reply(message, `「${target.name}」正在执行，没有在等输入；为免打断它，这条没有发送。`);
      return;
    }
    try {
      await this.#options.send({ pane: target.pane, text, enter: true });
    } catch (error) {
      await this.#reply(message, `发送失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.#options.dismiss({ pane: target.pane });
    this.#recent = { target, at: this.#now() };
    await this.#reply(message, `✓ 已发送到「${target.name}」`);
  }

  async #deliverDispatch(
    message: TelegramMessage,
    target: Extract<SentNotice, { kind: "dispatch" }>,
    text: string,
  ): Promise<void> {
    const port = this.#options.dispatch;
    if (!port?.followup) {
      await this.#reply(message, "跨设备派活暂时不可用，没有发送。");
      return;
    }
    let result: { ok: true } | { ok: false; error: string };
    try {
      result = await port.followup(target.dispatchId, text);
    } catch (error) {
      await this.#reply(message, `发送失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!result.ok) {
      await this.#reply(message, `发送失败：${result.error}`);
      return;
    }
    this.#recent = { target, at: this.#now() };
    await this.#reply(message, `✓ 已发送到派出的会话「${target.name}」`);
  }

  async #deliverT3(
    message: TelegramMessage,
    target: Extract<SentNotice, { kind: "t3" }>,
    text: string,
  ): Promise<void> {
    const t3 = this.#t3;
    if (!t3) {
      await this.#reply(message, "T3 暂时连不上，没有发送。");
      return;
    }
    if (t3.status(target.threadId) === "waiting") {
      await this.#reply(message, `T3「${target.name}」在等你处理授权或提问，这一步要到 T3 里操作；这条没有发送。`);
      return;
    }
    let delivery: string;
    try {
      delivery = await t3.send(target.threadId, text, `${message.chat.id}-${message.message_id}`);
    } catch (error) {
      await this.#reply(message, `发送失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.#recent = { target, at: this.#now() };
    await this.#reply(
      message,
      delivery === "queued" ? `✓ 已排队到 T3「${target.name}」：它还在执行，做完这一轮就处理` : `✓ 已发送到 T3「${target.name}」`,
    );
  }

  /** 中转连接信息（地址 + 密钥），给另一台电脑粘贴用；没用中转时报错。 */
  async relayInvite(): Promise<string> {
    const relay = this.#stored.relay;
    const key = relay ? ((await this.#options.relayKey?.get().catch(() => null))?.trim() ?? "") : "";
    if (!relay || !key) throw new YouBrainError("INVALID_INPUT", "这台电脑还没有连接中转");
    return encodeRelayInvite(relay.url, key);
  }

  /** daemon 的 T3 适配器就绪后挂上；null 表示卸下。 */
  attachT3(port: TelegramT3Port | null): void {
    this.#t3 = port;
  }

  /** Telegram 已绑定（T3 监视据此决定要不要轮询）。 */
  bound(): boolean {
    return this.#canPush();
  }

  #canNotify(revision: number): boolean {
    return revision === this.#notificationRevision && this.#stored.notificationsEnabled && this.#canPush();
  }

  /** T3 会话做完一轮、等你处理或失败时调用：推到绑定的私聊，做完时带上最后一条回答。 */
  pushT3(notice: TelegramT3Notice): void {
    const revision = this.#notificationRevision;
    if (!this.#canNotify(revision)) return;
    const t3 = this.#t3;
    this.#pushChain = this.#pushChain.then(async () => {
      if (!this.#canNotify(revision)) return;
      try {
        const body = notice.kind === "done" && t3 ? await t3.answer(notice.threadId).catch(() => "") : "";
        if (!this.#canNotify(revision)) return;
        const sent = await this.#push(t3NoticeText(notice, body));
        const target: SentNotice = { kind: "t3", threadId: notice.threadId, name: notice.title };
        this.#sent.set(sent, target);
        this.#recent = { target, at: this.#now() };
        if (this.#sent.size > SENT_KEPT) this.#sent.delete(this.#sent.keys().next().value!);
      } catch {
        // 推送失败只丢这一条。
      }
    });
  }

  /** 跨设备派活结果到达时推送到绑定的私聊；带 dispatchId 时登记为「最近的会话」，直接回复就进被派的会话。 */
  pushDispatch(notice: TelegramDispatchNotice): void {
    const revision = this.#notificationRevision;
    if (!this.#canNotify(revision)) return;
    this.#pushChain = this.#pushChain.then(async () => {
      if (!this.#canNotify(revision)) return;
      try {
        const text = dispatchNoticeText(notice);
        let sent: number;
        if (this.#relay) {
          sent = await this.#relay.send(text, { push: true });
        } else {
          const api = this.#api;
          const chatId = this.#stored.chatId;
          if (!api || chatId === null) return;
          sent = (await api.sendMessage(chatId, text)).message_id;
        }
        if (notice.dispatchId) {
          const target: SentNotice = { kind: "dispatch", dispatchId: notice.dispatchId, name: notice.title };
          this.#sent.set(sent, target);
          this.#recent = { target, at: this.#now() };
          if (this.#sent.size > SENT_KEPT) this.#sent.delete(this.#sent.keys().next().value!);
        }
      } catch {
        // 推送失败只丢这一条。
      }
    });
  }

  /** 会话提醒有变化时调用：把新出现的「等你回复」和 AI 会话「已完成」推到绑定的私聊（不论电脑上是否正在看）。 */
  noticesChanged(): void {
    if (!this.#started || this.#cursor === null) return;
    const list = this.#options.notices();
    const from = list.epoch === this.#cursor.epoch ? this.#cursor.seq : 0;
    this.#cursor = { epoch: list.epoch, seq: Math.max(from, list.latest) };
    // 不看 status：用户正在电脑上看的会话，提醒一出生就是已关闭（桌面不弹），Telegram 仍要推送。
    const fresh = list.notices.filter((notice) => notice.seq > from && pushable(notice));
    const revision = this.#notificationRevision;
    if (fresh.length === 0 || !this.#canNotify(revision)) return;
    this.#pushChain = this.#pushChain.then(async () => {
      for (const notice of fresh) {
        if (!this.#canNotify(revision)) return;
        try {
          const sent = await this.#push(noticeText(notice.kind, notice.title, notice.body));
          const target: SentNotice = { kind: "tty7", pane: notice.pane, cwd: notice.cwd, name: notice.task ?? notice.sessionName };
          this.#sent.set(sent, target);
          this.#recent = { target, at: this.#now() };
          if (this.#sent.size > SENT_KEPT) this.#sent.delete(this.#sent.keys().next().value!);
        } catch {
          // 推送失败只丢这一条；连接状态由收消息循环反映。
        }
      }
    });
  }

  /** 测试用：等排队中的推送发完。 */
  flush(): Promise<void> {
    return this.#pushChain;
  }
}
