import { DurableObject } from "cloudflare:workers";

import { RelayCore, type RelaySocket, type TgUpdate } from "./core.js";

/**
 * Cloudflare 运行时外壳：
 * - `POST /telegram`：Telegram webhook，校验 secret_token 后交给 Durable Object。
 * - `GET /connect`：设备的 WebSocket，`Authorization: Bearer <RELAY_KEY>`，查询参数 device / name。
 * - `GET /check`：设备保存设置前检验地址与密钥。
 * 全部状态在一个名为 main 的 Durable Object 里（SQLite 存储，免费套餐可用）。
 */

export interface Env {
  RELAY: DurableObjectNamespace;
  /** @BotFather 给的 Bot Token（wrangler secret）。 */
  BOT_TOKEN: string;
  /** 设备连接密钥，至少 16 位（wrangler secret）。 */
  RELAY_KEY: string;
}

const TELEGRAM_API = "https://api.telegram.org";
const WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

function sameText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}

/** webhook 的 secret_token 由设备密钥派生，不用再多管一个密钥。 */
async function webhookSecret(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`u-brain-webhook:${key}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const key = env.RELAY_KEY ?? "";
  return key.length >= 16 && sameText(header, `Bearer ${key}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.RELAY.get(env.RELAY.idFromName("main"));
    if (url.pathname === "/telegram" && request.method === "POST") {
      const secret = request.headers.get(WEBHOOK_SECRET_HEADER) ?? "";
      if (!sameText(secret, await webhookSecret(env.RELAY_KEY ?? ""))) return new Response("forbidden", { status: 403 });
      return stub.fetch(request);
    }
    if (url.pathname === "/check") {
      if (!authorized(request, env)) return Response.json({ ok: false }, { status: 401 });
      return Response.json({ ok: true, botConfigured: Boolean(env.BOT_TOKEN) });
    }
    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
      return stub.fetch(request);
    }
    if (url.pathname === "/") return new Response("U-Brain Telegram relay\n");
    return new Response("not found", { status: 404 });
  },
};

interface Attachment {
  deviceId: string;
  name: string;
}

function clean(value: string | null, max: number): string {
  return (value ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}

export class Relay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 心跳由运行时直接应答，不唤醒对象、不计时长。
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  #core(exclude?: WebSocket): RelayCore {
    const token = this.env.BOT_TOKEN ?? "";
    return new RelayCore({
      storage: this.ctx.storage,
      sockets: () =>
        this.ctx
          .getWebSockets()
          .filter((ws) => ws !== exclude && ws.readyState === WebSocket.OPEN)
          .map((ws): RelaySocket => {
            const attachment = ws.deserializeAttachment() as Attachment;
            return { deviceId: attachment.deviceId, name: attachment.name, send: (frame) => ws.send(frame) };
          }),
      telegram: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
        if (!token) throw new Error("中转没有配置 BOT_TOKEN");
        const scrub = (text: string) => text.split(token).join("<token>");
        let body: { ok?: boolean; result?: unknown; description?: string };
        try {
          const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
          });
          body = (await response.json()) as typeof body;
        } catch (error) {
          throw new Error(`连不上 Telegram：${scrub(error instanceof Error ? error.message : String(error))}`);
        }
        if (body.ok !== true) throw new Error(`Telegram：${scrub(body.description ?? "请求失败")}`);
        return body.result as T;
      },
      now: () => Date.now(),
      randomInt: (max) => crypto.getRandomValues(new Uint32Array(1))[0]! % max,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/telegram") {
      // 总是回 200：处理失败也不让 Telegram 反复重投，免得同一句话打进终端两次。
      try {
        await this.#core().update((await request.json()) as TgUpdate);
      } catch {
        // 丢弃这一条。
      }
      return new Response("ok");
    }
    if (url.pathname === "/connect") {
      const deviceId = clean(url.searchParams.get("device"), 64);
      const name = clean(url.searchParams.get("name"), 40) || deviceId;
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(deviceId)) return new Response("bad device", { status: 400 });
      // 同一台设备重连：踢掉旧连接，免得一条消息投两次。
      for (const old of this.ctx.getWebSockets(deviceId)) old.close(4000, "replaced");
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [deviceId]);
      server.serializeAttachment({ deviceId, name } satisfies Attachment);
      const core = this.#core();
      const webhook = `${url.origin}/telegram`;
      this.ctx.waitUntil(
        (async () => {
          await core.ensureWebhook(webhook, await webhookSecret(this.env.RELAY_KEY ?? "")).catch(() => undefined);
          await core.connected(deviceId, name);
        })(),
      );
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    return new Response("not found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const attachment = ws.deserializeAttachment() as Attachment;
    await this.#core().frame(
      { deviceId: attachment.deviceId, name: attachment.name, send: (frame) => ws.send(frame) },
      message,
    );
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // 已经关了。
    }
    await this.#core(ws).broadcast();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.#core(ws).broadcast();
  }
}
