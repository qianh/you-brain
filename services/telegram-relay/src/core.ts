/**
 * U-Brain Telegram 中转的核心逻辑（与 Cloudflare 运行时无关，便于本地测试）。
 *
 * 一个 Bot 只能有一个消费者：Telegram 把消息 webhook 到这里，这里再按设备分发。
 * - 设备推送提醒：经这里调 sendMessage，记下「这条消息属于哪台设备」。
 * - 手机回复某条提醒：按被回复的消息找到设备，转给它。
 * - 手机直接发消息：转给最近推送过（或最近被回复过）的设备。
 * - 绑定私聊：设备申请绑定码，手机 `/start <码>` 后，这个中转只认这一个私聊。
 *
 * 设备 ⇄ 中转的帧（JSON 文本）：
 * - 设备 → 中转 `{t:"req", id, op:"send", text, replyTo?, push?}` / `{t:"req", id, op:"pair"}` / `{t:"req", id, op:"unbind"}`
 * - 中转 → 设备 `{t:"res", id, ok:true, result}` / `{t:"res", id, ok:false, error}`
 * - 中转 → 设备 `{t:"state", bot, bound, devices}` / `{t:"message", message}`
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
  send(frame: string): void;
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
/** [Telegram 消息 id, 设备 id]，新的在后。 */
type Routes = Array<[number, string]>;

export interface RelayState {
  bot: { username: string; name: string } | null;
  bound: { name: string } | null;
  devices: Array<{ id: string; name: string; online: boolean }>;
}

const ROUTES_KEPT = 1_000;
const DEVICES_KEPT = 200;
const PAIR_TTL_MS = 10 * 60_000;
const PAIR_MAX_FAILURES = 5;
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 直接发消息时，最近设备超过这么久就不再默认发给它（与设备端的会话时效一致）。 */
export const RECENT_DEVICE_TTL_MS = 2 * 60 * 60_000;
const TEXT_MAX = 4_000;

function displayName(message: TgMessage): string {
  const from = message.from;
  if (from?.username) return `@${from.username}`;
  return [from?.first_name, from?.last_name].filter(Boolean).join(" ") || String(message.chat.id);
}

export class RelayCore {
  readonly #ports: RelayPorts;

  constructor(ports: RelayPorts) {
    this.#ports = ports;
  }

  #get<T>(key: string): Promise<T | undefined> {
    return this.#ports.storage.get<T>(key);
  }

  async #bot(): Promise<Bot> {
    const cached = await this.#get<Bot>("bot");
    if (cached) return cached;
    const me = await this.#ports.telegram<{ id: number; username?: string; first_name?: string }>("getMe", {});
    const bot = { id: me.id, username: me.username ?? "", name: me.first_name ?? "" };
    await this.#ports.storage.put("bot", bot);
    return bot;
  }

  async state(): Promise<RelayState> {
    const [bot, chat, devices] = await Promise.all([
      this.#get<Bot>("bot"),
      this.#get<Chat>("chat"),
      this.#get<Devices>("devices"),
    ]);
    const online = new Set(this.#ports.sockets().map((socket) => socket.deviceId));
    return {
      bot: bot ? { username: bot.username, name: bot.name } : null,
      bound: chat ? { name: chat.name } : null,
      devices: Object.entries(devices ?? {})
        .sort((a, b) => b[1].seenAt - a[1].seenAt)
        .map(([id, device]) => ({ id, name: device.name, online: online.has(id) })),
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

  /** 设备连上（运行时已校验密钥）：登记名字，让 Bot 信息就绪，再把状态发给所有设备。 */
  async connected(deviceId: string, name: string): Promise<void> {
    const devices = (await this.#get<Devices>("devices")) ?? {};
    devices[deviceId] = { name, seenAt: this.#ports.now() };
    const kept = Object.entries(devices)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, DEVICES_KEPT);
    await this.#ports.storage.put("devices", Object.fromEntries(kept));
    await this.#bot().catch(() => undefined);
    await this.broadcast();
  }

  /** webhook 地址变了才调 setWebhook（第一次部署、换域名、换 Bot）。 */
  async ensureWebhook(url: string, secret: string): Promise<void> {
    const bot = await this.#bot();
    const mark = `${bot.id}|${url}`;
    if ((await this.#get<string>("webhook")) === mark) return;
    await this.#ports.telegram("setWebhook", { url, secret_token: secret, allowed_updates: ["message"] });
    await this.#ports.storage.put("webhook", mark);
  }

  async frame(socket: RelaySocket, raw: string): Promise<void> {
    let request: { t?: unknown; id?: unknown; op?: unknown; text?: unknown; replyTo?: unknown; push?: unknown };
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
    request: { op?: unknown; text?: unknown; replyTo?: unknown; push?: unknown },
  ): Promise<unknown> {
    switch (request.op) {
      case "send": {
        const chat = await this.#get<Chat>("chat");
        if (!chat) throw new Error("还没有绑定 Telegram");
        if (typeof request.text !== "string" || request.text.trim() === "") throw new Error("消息为空");
        const push = request.push === true;
        const replyTo = typeof request.replyTo === "number" ? request.replyTo : undefined;
        const devices = (await this.#get<Devices>("devices")) ?? {};
        // 多台设备时在推送开头标出是哪台，单台不加，免得啰嗦。
        const prefix = push && Object.keys(devices).length > 1 ? `💻 ${socket.name}\n` : "";
        const sent = await this.#send(chat.id, `${prefix}${request.text}`, replyTo);
        if (push) {
          await this.#route(sent, socket.deviceId);
          await this.#ports.storage.put("recent", { deviceId: socket.deviceId, at: this.#ports.now() } satisfies Recent);
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

  async #route(messageId: number, deviceId: string): Promise<void> {
    const routes = (await this.#get<Routes>("routes")) ?? [];
    routes.push([messageId, deviceId]);
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
