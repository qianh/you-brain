/**
 * U-Brain Telegram 中转的核心逻辑（与 Cloudflare 运行时无关，便于本地测试）。
 *
 * 一个 Bot 只能有一个消费者：Telegram 把消息 webhook 到这里，这里再按设备分发。
 * - 设备推送提醒：经这里调 sendMessage，记下「这条消息属于哪台设备」。
 * - 手机回复某条提醒：按被回复的消息找到设备，转给它。
 * - 手机直接发消息：配了「路由设备」（VPS）且在线时，带上候选推送清单交给它判断是回哪一条，
 *   由它用 `forward` 指定目标；没配或不在线时，转给最近推送过（或最近被回复过）的设备。
 * - 绑定私聊：设备申请绑定码，手机 `/start <码>` 后，这个中转只认这一个私聊。
 *
 * 设备 ⇄ 中转的帧（JSON 文本）：
 * - 设备 → 中转 `{t:"req", id, op:"send", text, replyTo?, push?}` / `{t:"req", id, op:"pair"}` / `{t:"req", id, op:"unbind"}`
 * - 中转 → 设备 `{t:"res", id, ok:true, result}` / `{t:"res", id, ok:false, error}`
 * - 设备（仅路由设备）→ 中转 `{t:"req", id, op:"forward", message, target}`：把一条没引用的消息转给 `target` 那条推送的设备
 * - 中转 → 设备 `{t:"state", bot, bound, devices}` / `{t:"message", message}`
 * - 中转 → 路由设备 `{t:"route", message, candidates:[{id, deviceId, deviceName, preview, at}]}`
 * - 心跳：设备发文本 `ping`，运行时自动回 `pong`，不唤醒 Durable Object。
 */

export interface RelayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
}

export interface RelaySocket {
  deviceId: string;
  name: string;
  auth?: "enrolled" | "legacy";
  send(frame: string): void;
}

export interface RelayDeviceMeta {
  enrolled: boolean;
  publicKey?: string;
  dispatch?: unknown;
}

export interface RelayPorts {
  storage: RelayStorage;
  /** 当前在线的设备连接。 */
  sockets(): RelaySocket[];
  /** 调 Telegram Bot API；失败抛 Error（信息里不能带 Token）。 */
  telegram<T>(method: string, params: Record<string, unknown>): Promise<T>;
  now(): number;
  /** 取 [0, max) 的随机整数，生成绑定码用。 */
  randomInt(max: number): number;
  /** 可选：路由设备的 deviceId。不引用的消息交给它按内容判断是回哪条推送。 */
  routerDeviceId?: string;
  /** 可选：是否启用了 Telegram Bot（默认 true；显式传 false 时以纯设备中转与原生推送模式运行，不调 Telegram API）。 */
  botConfigured?: boolean;
  /** 可选：为 state.devices 补充入网状态、公钥与最近一次 hello 的 dispatch 信息。 */
  deviceMeta?: (deviceId: string) => Promise<RelayDeviceMeta | undefined> | RelayDeviceMeta | undefined;
}

export interface TgMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type: string; first_name?: string; username?: string };
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  text?: string;
  reply_to_message?: { message_id: number };
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface Chat {
  id: number;
  name: string;
}
interface Recent {
  deviceId: string;
  at: number;
}
interface Pair {
  code: string;
  expiresAt: number;
  failures: number;
}
interface Bot {
  id: number;
  username: string;
  name: string;
}
type Devices = Record<string, { name: string; seenAt: number }>;
/** [Telegram 消息 id, 设备 id, 正文摘要, 推送时间]，新的在后；老数据只有前两项。 */
type Routes = Array<[number, string, string?, number?]>;

export interface RelayRouteCandidate {
  id: number;
  deviceId: string;
  deviceName: string;
  preview: string;
  at: number;
}

export interface RelayStateDevice {
  id: string;
  name: string;
  online: boolean;
  enrolled?: boolean;
  publicKey?: string;
  dispatch?: unknown;
}

export type MobilePushKind = "tty7" | "t3" | "dispatch" | "reminder" | "notice";
export type MobilePushStatus = "done" | "waiting" | "failed" | "info";

export interface MobilePushItem {
  seq: number;
  ts: number;
  deviceId: string;
  deviceName: string;
  kind: MobilePushKind;
  status?: MobilePushStatus;
  title: string;
  body: string;
  link?: string | null;
  threadId?: string | null;
  replyToken?: string | null;
}

export interface RelayState {
  bot: { username: string; name: string } | null;
  bound: { name: string } | null;
  routerDeviceId?: string | null;
  devices: RelayStateDevice[];
}

const ROUTES_KEPT = 1_000;
const PUSHES_KEPT = 500;
const PUSH_TITLE_MAX = 200;
const PUSH_BODY_MAX = 8_000;
const PUSH_LIST_DEFAULT = 100;
const PUSH_LIST_MAX = 200;
const MOBILE_PUSH_KINDS = new Set<MobilePushKind>(["tty7", "t3", "dispatch", "reminder", "notice"]);
const MOBILE_PUSH_STATUSES = new Set<MobilePushStatus>(["done", "waiting", "failed", "info"]);
/** 交给路由设备判断时带上多少条最近的推送，以及多久以前的不再算。 */
const CANDIDATES_MAX = 8;
export const CANDIDATE_TTL_MS = 6 * 60 * 60_000;
const PREVIEW_MAX = 160;
const DEVICES_KEPT = 200;
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_MAX_FAILURES = 5;
export const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 直接发消息时，最近设备超过这么久就不再默认发给它（与设备端的会话时效一致）。 */
export const RECENT_DEVICE_TTL_MS = 2 * 60 * 60_000;
/** 同一 url 比对成功后，这段时间内不再请求 Telegram。只放进程内存，不写 storage。 */
const WEBHOOK_RECHECK_MS = 60_000;

function webhookUrlOf(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return undefined;
  const url = (info as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}
const TEXT_MAX = 4_000;

function displayName(message: TgMessage): string {
  const from = message.from;
  if (from?.username) return `@${from.username}`;
  return [from?.first_name, from?.last_name].filter(Boolean).join(" ") || String(message.chat.id);
}

interface RelayRequest {
  t?: unknown;
  id?: unknown;
  op?: unknown;
  text?: unknown;
  replyTo?: unknown;
  push?: unknown;
  message?: unknown;
  target?: unknown;
  kind?: unknown;
  status?: unknown;
  title?: unknown;
  body?: unknown;
  link?: unknown;
  threadId?: unknown;
  replyToken?: unknown;
  telegramText?: unknown;
  sinceSeq?: unknown;
  limit?: unknown;
}

function previewOf(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat;
}

export class RelayCore {
  readonly #ports: RelayPorts;
  /** 最近一次确认过的 webhook url → 到期时间。换进程即失效，所以回滚后会重新比对。 */
  #webhookOk = new Map<string, number>();

  constructor(ports: RelayPorts) {
    this.#ports = ports;
  }

  #get<T>(key: string): Promise<T | undefined> {
    return this.#ports.storage.get<T>(key);
  }

  #hasBot(): boolean {
    return this.#ports.botConfigured !== false;
  }

  async #bot(): Promise<Bot> {
    if (!this.#hasBot()) throw new Error("中转没有配置 BOT_TOKEN");
    const cached = await this.#get<Bot>("bot");
    if (cached) return cached;
    const me = await this.#ports.telegram<{ id: number; username?: string; first_name?: string }>("getMe", {});
    const bot = { id: me.id, username: me.username ?? "", name: me.first_name ?? "" };
    await this.#ports.storage.put("bot", bot);
    return bot;
  }

  async state(): Promise<RelayState> {
    const hasBot = this.#hasBot();
    const [bot, chat, devices] = await Promise.all([
      hasBot ? this.#get<Bot>("bot") : Promise.resolve(undefined),
      hasBot ? this.#get<Chat>("chat") : Promise.resolve(undefined),
      this.#get<Devices>("devices"),
    ]);
    const online = new Set(this.#ports.sockets().map((socket) => socket.deviceId));
    const sorted = Object.entries(devices ?? {}).sort((a, b) => b[1].seenAt - a[1].seenAt);
    const list: RelayStateDevice[] = [];
    for (const [id, device] of sorted) {
      const item: RelayStateDevice = { id, name: device.name, online: online.has(id) };
      const meta = this.#ports.deviceMeta ? await this.#ports.deviceMeta(id) : undefined;
      if (meta) {
        item.enrolled = meta.enrolled;
        if (meta.publicKey !== undefined) item.publicKey = meta.publicKey;
        if (meta.dispatch !== undefined) item.dispatch = meta.dispatch;
      }
      list.push(item);
    }
    return {
      bot: bot ? { username: bot.username, name: bot.name } : null,
      bound: chat ? { name: chat.name } : null,
      ...(this.#ports.routerDeviceId ? { routerDeviceId: this.#ports.routerDeviceId } : {}),
      devices: list,
    };
  }

  async broadcast(): Promise<void> {
    const frame = JSON.stringify({ t: "state", ...(await this.state()) });
    for (const socket of this.#ports.sockets()) {
      try {
        socket.send(frame);
      } catch {
        // 断开中的连接，下次重连会再拿到状态。
      }
    }
  }

  /** 设备连上（运行时已校验密钥）：登记名字，如启用了 Bot 则让 Bot 信息就绪，再把状态发给所有设备。 */
  async connected(deviceId: string, name: string): Promise<void> {
    const devices = (await this.#get<Devices>("devices")) ?? {};
    devices[deviceId] = { name, seenAt: this.#ports.now() };
    const kept = Object.entries(devices)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, DEVICES_KEPT);
    await this.#ports.storage.put("devices", Object.fromEntries(kept));
    if (this.#hasBot()) {
      await this.#bot().catch(() => undefined);
    }
    await this.broadcast();
  }

  /**
   * 先向 Telegram 要当前 webhook。url 已经是目标就不再 setWebhook。
   * 不能只信 storage 里的「已设置」：回滚到另一套中转时，那边记得设过，但 Telegram 实际还指向这边。
   * 同一个 url 在 60 秒内比对成功则跳过请求；这个标记只在内存里。
   */
  async ensureWebhook(url: string, secret: string): Promise<void> {
    if (!this.#hasBot()) return;
    const now = this.#ports.now();
    const until = this.#webhookOk.get(url);
    if (until !== undefined && now < until) return;
    await this.#bot();
    const info = await this.#ports.telegram<unknown>("getWebhookInfo", {});
    if (webhookUrlOf(info) !== url) {
      await this.#ports.telegram("setWebhook", { url, secret_token: secret, allowed_updates: ["message"] });
    }
    this.#webhookOk.clear();
    this.#webhookOk.set(url, now + WEBHOOK_RECHECK_MS);
  }

  async frame(socket: RelaySocket, raw: string): Promise<void> {
    let request: RelayRequest;
    try {
      request = JSON.parse(raw) as typeof request;
    } catch {
      return;
    }
    if (request.t !== "req" || typeof request.id !== "string") return;
    const id = request.id;
    try {
      const result = await this.#request(socket, request);
      socket.send(JSON.stringify({ t: "res", id, ok: true, result }));
    } catch (error) {
      socket.send(JSON.stringify({ t: "res", id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  async #request(
    socket: RelaySocket,
    request: RelayRequest,
  ): Promise<unknown> {
    switch (request.op) {
      case "forward":
        return this.#forward(socket, request);
      case "notify":
        return this.#notify(socket, request);
      case "pushes":
        return this.#pushes(socket, request);
      case "send": {
        const chat = this.#hasBot() ? await this.#get<Chat>("chat") : undefined;
        if (!chat) throw new Error("还没有绑定 Telegram");
        if (typeof request.text !== "string" || request.text.trim() === "") throw new Error("消息为空");
        const push = request.push === true;
        const replyTo = typeof request.replyTo === "number" ? request.replyTo : undefined;
        const devices = (await this.#get<Devices>("devices")) ?? {};
        // 多台设备时在推送开头标出是哪台，单台不加，免得啰嗦。
        const prefix = push && Object.keys(devices).length > 1 ? `💻 ${socket.name}\n` : "";
        const sent = await this.#send(chat.id, `${prefix}${request.text}`, replyTo);
        if (push) {
          await this.#route(sent, socket.deviceId, previewOf(request.text));
          await this.#ports.storage.put("recent", { deviceId: socket.deviceId, at: this.#ports.now() } satisfies Recent);
          if (socket.auth === "enrolled") {
            const text = request.text.trim();
            await this.#appendPush(socket, {
              kind: "notice",
              status: "info",
              title: socket.name,
              body: text.slice(0, PUSH_BODY_MAX),
            });
          }
        }
        return { messageId: sent };
      }
      case "pair": {
        const bot = await this.#bot();
        let code = "";
        for (let index = 0; index < 8; index += 1) code += PAIR_ALPHABET[this.#ports.randomInt(PAIR_ALPHABET.length)];
        const pair: Pair = { code, expiresAt: this.#ports.now() + PAIR_TTL_MS, failures: 0 };
        await this.#ports.storage.put("pair", pair);
        return {
          code,
          link: `https://t.me/${bot.username}?start=${code}`,
          expiresAt: new Date(pair.expiresAt).toISOString(),
        };
      }
      case "unbind":
        await Promise.all(["chat", "pair", "routes", "recent"].map((key) => this.#ports.storage.delete(key)));
        await this.broadcast();
        return {};
      default:
        throw new Error("不支持的操作");
    }
  }

  async #notify(socket: RelaySocket, request: RelayRequest): Promise<{ seq: number; messageId: number | null }> {
    if (socket.auth !== "enrolled") throw new Error("请先入网");
    const kind =
      typeof request.kind === "string" && MOBILE_PUSH_KINDS.has(request.kind as MobilePushKind)
        ? (request.kind as MobilePushKind)
        : null;
    if (!kind) throw new Error("推送类型不合法");
    let status: MobilePushStatus | undefined;
    if (request.status !== undefined) {
      if (typeof request.status !== "string" || !MOBILE_PUSH_STATUSES.has(request.status as MobilePushStatus)) {
        throw new Error("推送状态不合法");
      }
      status = request.status as MobilePushStatus;
    }
    const title = typeof request.title === "string" ? request.title.trim().slice(0, PUSH_TITLE_MAX) : "";
    if (!title) throw new Error("推送标题为空");
    const body = typeof request.body === "string" ? request.body.trim().slice(0, PUSH_BODY_MAX) : "";
    const link =
      typeof request.link === "string" && request.link.trim() !== ""
        ? request.link.trim().slice(0, 2_000)
        : request.link === null
          ? null
          : undefined;
    const threadId =
      typeof request.threadId === "string" && request.threadId.trim() !== ""
        ? request.threadId.trim().slice(0, 200)
        : request.threadId === null
          ? null
          : undefined;
    const replyToken =
      typeof request.replyToken === "string" && request.replyToken.trim() !== ""
        ? request.replyToken.trim().slice(0, 200)
        : request.replyToken === null
          ? null
          : undefined;

    const item = await this.#appendPush(socket, {
      kind,
      ...(status !== undefined ? { status } : {}),
      title,
      body,
      ...(link !== undefined ? { link } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      ...(replyToken !== undefined ? { replyToken } : {}),
    });

    let messageId: number | null = null;
    const telegramText = typeof request.telegramText === "string" ? request.telegramText.trim() : "";
    if (this.#hasBot() && telegramText !== "") {
      const chat = await this.#get<Chat>("chat");
      if (chat) {
        const devices = (await this.#get<Devices>("devices")) ?? {};
        const prefix = Object.keys(devices).length > 1 ? `💻 ${socket.name}\n` : "";
        try {
          const sent = await this.#send(chat.id, `${prefix}${telegramText}`);
          await this.#route(sent, socket.deviceId, previewOf(telegramText));
          await this.#ports.storage.put("recent", { deviceId: socket.deviceId, at: this.#ports.now() } satisfies Recent);
          messageId = sent;
        } catch {
          // Telegram 未绑定或发送失败时不阻断移动端推送。
        }
      }
    }
    return { seq: item.seq, messageId };
  }

  async #pushes(socket: RelaySocket, request: RelayRequest): Promise<{ items: MobilePushItem[]; latestSeq: number }> {
    if (socket.auth !== "enrolled") throw new Error("请先入网");
    const sinceSeq =
      typeof request.sinceSeq === "number" && Number.isFinite(request.sinceSeq) && request.sinceSeq >= 0
        ? Math.floor(request.sinceSeq)
        : 0;
    const rawLimit =
      typeof request.limit === "number" && Number.isFinite(request.limit)
        ? Math.floor(request.limit)
        : PUSH_LIST_DEFAULT;
    const limit = Math.max(1, Math.min(PUSH_LIST_MAX, rawLimit));
    const [pushes, latestSeq] = await Promise.all([
      this.#get<MobilePushItem[]>("pushes"),
      this.#get<number>("pushSeq"),
    ]);
    const list = (pushes ?? []).filter((item) => item.seq > sinceSeq).slice(-limit);
    return { items: list, latestSeq: latestSeq ?? 0 };
  }

  async #appendPush(
    socket: RelaySocket,
    input: {
      kind: MobilePushKind;
      status?: MobilePushStatus;
      title: string;
      body: string;
      link?: string | null;
      threadId?: string | null;
      replyToken?: string | null;
    },
  ): Promise<MobilePushItem> {
    const seq = ((await this.#get<number>("pushSeq")) ?? 0) + 1;
    const item: MobilePushItem = {
      seq,
      ts: this.#ports.now(),
      deviceId: socket.deviceId,
      deviceName: socket.name,
      kind: input.kind,
      ...(input.status !== undefined ? { status: input.status } : {}),
      title: input.title,
      body: input.body,
      ...(input.link !== undefined ? { link: input.link } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.replyToken !== undefined ? { replyToken: input.replyToken } : {}),
    };
    const pushes = (await this.#get<MobilePushItem[]>("pushes")) ?? [];
    pushes.push(item);
    await this.#ports.storage.put("pushSeq", seq);
    await this.#ports.storage.put("pushes", pushes.slice(-PUSHES_KEPT));
    const frame = JSON.stringify({ t: "push", item });
    for (const target of this.#ports.sockets()) {
      if (target.auth !== "enrolled") continue;
      try {
        target.send(frame);
      } catch {
        // 断开中的连接，重连后会用 pushes 补拉。
      }
    }
    return item;
  }

  async #send(chatId: number, text: string, replyTo?: number): Promise<number> {
    const clipped = text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text;
    const sent = await this.#ports.telegram<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: clipped,
      link_preview_options: { is_disabled: true },
      ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
    });
    return sent.message_id;
  }

  async #route(messageId: number, deviceId: string, preview: string): Promise<void> {
    const routes = (await this.#get<Routes>("routes")) ?? [];
    routes.push([messageId, deviceId, preview, this.#ports.now()]);
    await this.#ports.storage.put("routes", routes.slice(-ROUTES_KEPT));
  }

  async #reply(message: TgMessage, text: string): Promise<void> {
    await this.#send(message.chat.id, text, message.message_id).catch(() => undefined);
  }

  /** Telegram webhook 来的一条更新（运行时已校验 secret_token）。 */
  async update(update: TgUpdate): Promise<void> {
    const message = update.message;
    if (!message || message.chat.type !== "private") return;
    const text = message.text?.trim() ?? "";
    const chat = await this.#get<Chat>("chat");
    if (!chat || chat.id !== message.chat.id) {
      await this.#stranger(message, text, chat !== undefined);
      return;
    }
    if (text.startsWith("/")) {
      await this.#reply(message, await this.#help());
      return;
    }
    const replyTo = message.reply_to_message?.message_id;
    let deviceId: string | undefined;
    if (replyTo !== undefined) {
      deviceId = ((await this.#get<Routes>("routes")) ?? []).find(([id]) => id === replyTo)?.[1];
      if (deviceId === undefined) {
        await this.#reply(message, "这条消息不是可回复的提醒，或提醒已过期。请回复最新的提醒。");
        return;
      }
    } else {
      if (await this.#routeToRouter(message)) return;
      const recent = await this.#get<Recent>("recent");
      if (!recent || this.#ports.now() - recent.at > RECENT_DEVICE_TTL_MS) {
        await this.#reply(message, await this.#help());
        return;
      }
      deviceId = recent.deviceId;
    }
    const sockets = this.#ports.sockets().filter((socket) => socket.deviceId === deviceId);
    if (sockets.length === 0) {
      const name = ((await this.#get<Devices>("devices")) ?? {})[deviceId]?.name ?? "那台设备";
      await this.#reply(message, `「${name}」现在不在线（U-Brain 没开或断网），这条没有发送。`);
      return;
    }
    const frame = JSON.stringify({ t: "message", message });
    for (const socket of sockets) socket.send(frame);
    await this.#ports.storage.put("recent", { deviceId, at: this.#ports.now() } satisfies Recent);
  }

  /** 不引用的消息：路由设备在线且有候选推送时交给它判断；返回 false 表示走原来的「最近设备」。 */
  async #routeToRouter(message: TgMessage): Promise<boolean> {
    const routerId = this.#ports.routerDeviceId;
    if (!routerId) return false;
    const sockets = this.#ports.sockets().filter((socket) => socket.deviceId === routerId);
    if (sockets.length === 0) return false;
    const candidates = await this.#candidates();
    if (candidates.length === 0) return false;
    const frame = JSON.stringify({ t: "route", message, candidates });
    for (const socket of sockets) socket.send(frame);
    return true;
  }

  /** 最近还没过期的推送，新的在前。 */
  async #candidates(): Promise<RelayRouteCandidate[]> {
    const now = this.#ports.now();
    const devices = (await this.#get<Devices>("devices")) ?? {};
    const result: RelayRouteCandidate[] = [];
    for (const [id, deviceId, preview, at] of [...((await this.#get<Routes>("routes")) ?? [])].reverse()) {
      if (typeof preview !== "string" || typeof at !== "number" || now - at > CANDIDATE_TTL_MS) continue;
      result.push({ id, deviceId, deviceName: devices[deviceId]?.name ?? "未知设备", preview, at });
      if (result.length >= CANDIDATES_MAX) break;
    }
    return result;
  }

  /** 路由设备判断完：把这条消息当作「回复了 target 那条推送」转给对应设备。 */
  async #forward(socket: RelaySocket, request: { message?: unknown; target?: unknown }): Promise<unknown> {
    if (!this.#ports.routerDeviceId || socket.deviceId !== this.#ports.routerDeviceId) throw new Error("这台设备不是路由设备");
    const chat = await this.#get<Chat>("chat");
    const message = request.message as TgMessage | undefined;
    if (!chat || !message || typeof message.message_id !== "number" || message.chat?.id !== chat.id) throw new Error("消息无效");
    if (typeof request.target !== "number") throw new Error("缺少目标");
    const route = ((await this.#get<Routes>("routes")) ?? []).find(([id]) => id === request.target);
    if (!route) throw new Error("目标推送已过期");
    const deviceId = route[1];
    const sockets = this.#ports.sockets().filter((item) => item.deviceId === deviceId);
    if (sockets.length === 0) {
      const name = ((await this.#get<Devices>("devices")) ?? {})[deviceId]?.name ?? "那台设备";
      throw new Error(`「${name}」现在不在线（U-Brain 没开或断网），这条没有发送。`);
    }
    const frame = JSON.stringify({ t: "message", message: { ...message, reply_to_message: { message_id: request.target } } });
    for (const item of sockets) item.send(frame);
    await this.#ports.storage.put("recent", { deviceId, at: this.#ports.now() } satisfies Recent);
    return {};
  }

  async #help(): Promise<string> {
    const state = await this.state();
    const online = state.devices.filter((device) => device.online).map((device) => `· ${device.name}`);
    return [
      "直接发消息，会发给最近推送过来的那台设备上的会话；要发给别的会话，长按那条提醒选「回复」。",
      "",
      online.length > 0 ? `在线的设备：\n${online.join("\n")}` : "现在没有在线的设备。",
    ].join("\n");
  }

  async #stranger(message: TgMessage, text: string, boundToOther: boolean): Promise<void> {
    // 已经绑了别人：一概不理，不暴露任何信息。
    if (boundToOther) return;
    const match = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (!match) return;
    const pair = await this.#get<Pair>("pair");
    const valid = pair !== undefined && pair.expiresAt > this.#ports.now() && match[1]?.toUpperCase() === pair.code;
    if (!valid) {
      if (pair && match[1]) {
        pair.failures += 1;
        if (pair.failures >= PAIR_MAX_FAILURES) await this.#ports.storage.delete("pair");
        else await this.#ports.storage.put("pair", pair);
      }
      await this.#reply(message, "绑定码无效或已过期。请在 U-Brain「设置 → 集成 → Telegram」里重新生成绑定链接。");
      return;
    }
    await this.#ports.storage.delete("pair");
    await this.#ports.storage.put("chat", { id: message.chat.id, name: displayName(message) } satisfies Chat);
    await this.broadcast();
    await this.#reply(
      message,
      "✅ 已绑定 U-Brain（中转）。\n\n各台设备上的终端会话等你回复、或 AI 会话做完一轮时，会推送到这里；直接发消息会发给最近推送过来的会话，要指定别的会话就长按那条提醒选「回复」。",
    );
  }
}
