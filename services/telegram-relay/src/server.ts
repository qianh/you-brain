import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ServerWebSocket } from "bun";

import { RelayAuditLog } from "./audit.js";
import { RelayCore, type RelayStorage, type TgUpdate } from "./core.js";
import { DispatchRouter, type DispatchSocket, type RelayTurnConfig, type SocketAuth } from "./dispatch.js";
import { cleanText, DEVICE_ID_RE, EnrollStore, sameText, TOKEN_PREFIX } from "./enroll.js";

/**
 * Bun 运行时外壳：
 * - `POST /telegram`：校验 secret_token，总是回 200，处理失败也吞掉。
 * - `GET /check`：接受设备令牌（`ubd_`）或过渡期旧 `RELAY_KEY`。
 * - `GET /connect`：设备 WebSocket。同一台设备重连踢掉旧连接（4000）；吊销断开（4001）。
 * - `POST /enroll`：公开端点，凭一次性邀请码换取设备令牌并上报 Ed25519 公钥。
 * - `POST /admin/invite`、`POST /admin/revoke`、`GET /admin/devices`：本机管理端点（带转发头一律 404）。
 * 所有状态读—改—写和设备间路由统一走串行队列。
 */

export interface RelayServerOptions {
  port: number;
  /** 默认只听本机，交给反代。 */
  host?: string;
  botToken: string;
  relayKey: string;
  dataDir: string;
  /** 测试里指向假的 Telegram。默认 https://api.telegram.org。 */
  telegramApi?: string;
  /** 过渡期是否接受旧共享密钥 RELAY_KEY 连接 /connect 与 /check。默认 true。 */
  acceptLegacyKey?: boolean;
  /** 待结果超时毫秒数，默认 5 分钟（300_000）。 */
  pendingTimeoutMs?: number;
  /** 固定的公网地址（如 https://relay.example.com）。设置后 webhook 地址不再从请求头推断，经隧道时更稳。 */
  publicOrigin?: string;
  /** 路由设备（VPS 的 deviceId）：不引用的 Telegram 消息交给它按内容判断是回哪条推送。 */
  routerDeviceId?: string;
  /** 可选 WebRTC TURN 服务器配置（RELAY_TURN_URLS / RELAY_TURN_SECRET）。 */
  turn?: RelayTurnConfig;
  now?: () => number;
  randomInt?: (max: number) => number;
}

export interface RelayServer {
  port: number;
  stop(): Promise<void>;
}

const WEBHOOK_SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";
const OPEN = 1;
/** 每台设备每小时最多申请 30 个邀请码。 */
const INVITE_RATE_MAX = 30;
const INVITE_RATE_WINDOW_MS = 60 * 60_000;

interface SocketData {
  deviceId: string;
  name: string;
  auth: SocketAuth;
  /** 后来的连接数字更大，用来在同时连上时只留最新的一条。 */
  generation: number;
  webhook: string;
}

type RequestAuth =
  | { kind: "enrolled"; deviceId: string }
  | { kind: "legacy" };

/** webhook 的 secret_token 由设备密钥派生，不用再多管一个密钥。 */
async function webhookSecret(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`u-brain-webhook:${key}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const value = header.slice("Bearer ".length);
  return value.length > 0 ? value : null;
}

function authorizedLegacyKey(request: Request, relayKey: string): boolean {
  const token = bearerToken(request);
  return token !== null && relayKey.length >= 16 && sameText(token, relayKey);
}

function isForwardedRequest(request: Request): boolean {
  return request.headers.has("x-forwarded-for") || request.headers.has("forwarded");
}

/** Caddy 会带上 X-Forwarded-Proto。本机直连时用请求自己的 origin。 */
function publicOrigin(request: Request, fixed?: string): string {
  if (fixed) return fixed;
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (forwarded === "https" || forwarded === "http") return `${forwarded}://${url.host}`;
  return url.origin;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

/** 一个接一个执行。前一个失败也不挡住后面的。 */
class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  drain(): Promise<void> {
    return this.#tail;
  }
}

class FileRelayStorage implements RelayStorage {
  #data: Record<string, unknown> = {};
  #file: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        this.#data = {};
        return;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("状态文件不是对象");
      this.#data = parsed as Record<string, unknown>;
    } catch {
      // 先挪走坏文件再从空状态启动，避免下一次写入把它盖掉。
      await rename(this.#file, `${this.#file}.corrupt-${Date.now()}`);
      this.#data = {};
      return;
    }
    await chmod(this.#file, 0o600);
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!Object.prototype.hasOwnProperty.call(this.#data, key)) return undefined;
    return structuredClone(this.#data[key]) as T;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.#data[key] = structuredClone(value);
    await this.#flush();
  }

  async delete(key: string): Promise<boolean> {
    const had = Object.prototype.hasOwnProperty.call(this.#data, key);
    delete this.#data[key];
    await this.#flush();
    return had;
  }

  #flush(): Promise<void> {
    const write = this.#pending.then(() => this.#write(JSON.stringify(this.#data)));
    this.#pending = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  async #write(json: string): Promise<void> {
    const tmp = `${this.#file}.tmp`;
    await writeFile(tmp, json, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.#file);
  }
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const host = options.host ?? "127.0.0.1";
  const token = options.botToken;
  const relayKey = options.relayKey;
  const acceptLegacyKey = options.acceptLegacyKey ?? true;
  const fixedOrigin = options.publicOrigin?.trim().replace(/\/+$/u, "") || undefined;
  const telegramApi = (options.telegramApi ?? "https://api.telegram.org").replace(/\/$/u, "");
  const now = options.now ?? (() => Date.now());
  const randomInt = options.randomInt ?? ((max) => crypto.getRandomValues(new Uint32Array(1))[0]! % max);
  const secret = await webhookSecret(relayKey);
  const scrub = (text: string) => (token === "" ? text : text.split(token).join("<token>"));

  const storage = new FileRelayStorage(join(options.dataDir, "state.json"));
  await storage.load();
  const auditLog = new RelayAuditLog(options.dataDir);
  const queue = new SerialQueue();
  const connections = new Set<ServerWebSocket<SocketData>>();
  const replaced = new WeakSet<ServerWebSocket<SocketData>>();
  let generation = 0;
  let stopping = false;

  const activeSockets = (): DispatchSocket[] => {
    const list: DispatchSocket[] = [];
    for (const ws of connections) {
      if (ws.readyState !== OPEN) continue;
      list.push({
        deviceId: ws.data.deviceId,
        name: ws.data.name,
        auth: ws.data.auth,
        send: (frame) => {
          if (ws.readyState === OPEN) ws.send(frame);
        },
      });
    }
    return list;
  };

  const enroll = new EnrollStore({
    storage,
    now,
    randomInt,
    audit: (entry) => auditLog.write(entry),
  });

  const dispatch: DispatchRouter = new DispatchRouter({
    sockets: activeSockets,
    now,
    audit: (entry) => auditLog.write(entry),
    broadcast: () => core.broadcast(),
    enqueue: (task) => {
      void queue.run(async () => {
        await task();
      }).catch(() => undefined);
    },
    ...(options.pendingTimeoutMs !== undefined ? { pendingTimeoutMs: options.pendingTimeoutMs } : {}),
    ...(options.turn !== undefined ? { turn: options.turn } : {}),
  });

  const core: RelayCore = new RelayCore({
    storage,
    sockets: activeSockets,
    telegram: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (!token) throw new Error("中转没有配置 BOT_TOKEN");
      let body: { ok?: boolean; result?: unknown; description?: string };
      try {
        const response = await fetch(`${telegramApi}/bot${token}/${method}`, {
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
    now,
    randomInt,
    ...(options.routerDeviceId ? { routerDeviceId: options.routerDeviceId } : {}),
    deviceMeta: async (deviceId) => {
      const active = await enroll.getActive(deviceId);
      const hello = active ? dispatch.getHello(deviceId) : undefined;
      return {
        enrolled: active !== undefined,
        ...(active ? { publicKey: active.publicKey } : {}),
        ...(hello !== undefined ? { dispatch: hello } : {}),
      };
    },
  });

  const inviteIssued = new Map<string, number[]>();
  const authenticateDeviceOrLegacy = async (request: Request): Promise<RequestAuth | null> => {
    const bearer = bearerToken(request);
    if (bearer === null) return null;
    if (bearer.startsWith(TOKEN_PREFIX)) {
      const matched = await enroll.authenticateToken(bearer);
      if (!matched) return null;
      return { kind: "enrolled", deviceId: matched.deviceId };
    }
    if (!acceptLegacyKey) return null;
    if (relayKey.length >= 16 && sameText(bearer, relayKey)) {
      return { kind: "legacy" };
    }
    return null;
  };

  const dropSocket = (ws: ServerWebSocket<SocketData>, code: number, reason: string): void => {
    replaced.add(ws);
    connections.delete(ws);
    try {
      ws.close(code, reason);
    } catch {
      // 已经在关。
    }
  };

  /** 同一设备只留 generation 最大的那条。返回当前这条是否还在。 */
  const keepNewest = (ws: ServerWebSocket<SocketData>): boolean => {
    const same = [...connections].filter((item) => item.data.deviceId === ws.data.deviceId);
    let newest = ws.data.generation;
    for (const item of same) if (item.data.generation > newest) newest = item.data.generation;
    for (const item of same) {
      if (item.data.generation !== newest) dropSocket(item, 4000, "replaced");
    }
    if (ws.data.generation !== newest) {
      dropSocket(ws, 4000, "replaced");
      return false;
    }
    return true;
  };

  const server = Bun.serve<SocketData>({
    hostname: host,
    port: options.port,
    error(error) {
      const message = error instanceof Error ? error.message : "未知错误";
      console.error(`中转请求失败：${scrub(message)}`);
      return new Response("error", { status: 500 });
    },
    fetch(request, bun) {
      const url = new URL(request.url);
      if (url.pathname === "/telegram" && request.method === "POST") {
        const header = request.headers.get(WEBHOOK_SECRET_HEADER) ?? "";
        if (!sameText(header, secret)) return new Response("forbidden", { status: 403 });
        return (async () => {
          try {
            const update = (await request.json()) as TgUpdate;
            await queue.run(() => core.update(update));
          } catch {
            // 丢弃这一条。总是回 200，免得 Telegram 反复重投。
          }
          return new Response("ok");
        })();
      }

      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        if (isForwardedRequest(request)) return new Response("not found", { status: 404 });
        if (!authorizedLegacyKey(request, relayKey)) {
          return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        }
        if (url.pathname === "/admin/invite" && request.method === "POST") {
          return queue.run(async () => Response.json(await enroll.createInvite()));
        }
        if (url.pathname === "/admin/revoke" && request.method === "POST") {
          return queue.run(async () => {
            let payload: unknown;
            try {
              payload = await request.json();
            } catch {
              return Response.json({ error: "请求体格式错误" }, { status: 400 });
            }
            const deviceId =
              typeof payload === "object" && payload !== null && "deviceId" in payload
                ? String((payload as { deviceId?: unknown }).deviceId ?? "")
                : "";
            const result = await enroll.revoke(deviceId);
            if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
            for (const ws of [...connections]) {
              if (ws.data.deviceId === result.deviceId) {
                dropSocket(ws, 4001, "revoked");
              }
            }
            await dispatch.clearDevice(result.deviceId);
            await core.broadcast();
            return Response.json({ ok: true, deviceId: result.deviceId, revokedAt: result.revokedAt });
          });
        }
        if (url.pathname === "/admin/devices" && request.method === "GET") {
          return queue.run(async () => {
            const online = new Set([...connections].filter((ws) => ws.readyState === OPEN).map((ws) => ws.data.deviceId));
            const devices = await enroll.listDevices(online);
            return Response.json({ devices });
          });
        }
        return new Response("not found", { status: 404 });
      }

      if (url.pathname === "/enroll" && request.method === "POST") {
        return queue.run(async () => {
          let payload: unknown;
          try {
            payload = await request.json();
          } catch {
            return Response.json({ error: "请求体格式错误" }, { status: 400 });
          }
          if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
            return Response.json({ error: "请求体格式错误" }, { status: 400 });
          }
          const body = payload as { code?: unknown; deviceId?: unknown; name?: unknown; publicKey?: unknown };
          const result = await enroll.redeem(body);
          return Response.json(result.body, { status: result.status });
        });
      }

      // 已入网设备凭自己的令牌换一个邀请码：设备把它写进同一个云盘账号，新设备读到后自动入网。
      if (url.pathname === "/invite" && request.method === "POST") {
        return queue.run(async () => {
          const bearer = bearerToken(request);
          const matched = bearer?.startsWith(TOKEN_PREFIX) ? await enroll.authenticateToken(bearer) : null;
          if (!matched) return Response.json({ error: "unauthorized" }, { status: 401 });
          const now = Date.now();
          const recent = (inviteIssued.get(matched.deviceId) ?? []).filter((at) => now - at < INVITE_RATE_WINDOW_MS);
          if (recent.length >= INVITE_RATE_MAX) {
            return Response.json({ error: "申请邀请码太频繁，请稍后再试" }, { status: 429 });
          }
          recent.push(now);
          inviteIssued.set(matched.deviceId, recent);
          // 带上中转的对外地址：VPS 上的设备经回环地址连中转，不能把回环地址写进云盘给别的设备用。
          return Response.json({ ...(await enroll.createInvite()), url: publicOrigin(request, fixedOrigin) });
        });
      }

      if (url.pathname === "/check") {
        return queue.run(async () => {
          const auth = await authenticateDeviceOrLegacy(request);
          if (!auth) return Response.json({ ok: false }, { status: 401 });
          return Response.json({ ok: true, botConfigured: Boolean(token) });
        });
      }

      if (url.pathname === "/connect") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return new Response("expected websocket", { status: 426 });
        }
        return queue.run(async (): Promise<Response | undefined> => {
          const auth = await authenticateDeviceOrLegacy(request);
          if (!auth) return new Response("unauthorized", { status: 401 });
          const deviceId = cleanText(url.searchParams.get("device"), 64);
          const name = cleanText(url.searchParams.get("name"), 40) || deviceId;
          if (!DEVICE_ID_RE.test(deviceId)) return new Response("bad device", { status: 400 });
          if (auth.kind === "enrolled" && auth.deviceId !== deviceId) {
            return new Response("unauthorized", { status: 401 });
          }
          if (auth.kind === "legacy" && (await enroll.enrolled())[deviceId]?.revokedAt !== undefined) {
            return new Response("unauthorized", { status: 401 });
          }
          generation += 1;
          const data: SocketData = {
            deviceId,
            name,
            auth: auth.kind,
            generation,
            webhook: `${publicOrigin(request, fixedOrigin)}/telegram`,
          };
          if (bun.upgrade(request, { data })) return undefined;
          return new Response("expected websocket", { status: 426 });
        });
      }

      if (url.pathname === "/") return new Response("U-Brain Telegram relay\n");
      return new Response("not found", { status: 404 });
    },
    websocket: {
      // 设备自己发文本 ping。关掉协议层心跳，也不要因为空闲把长连接拆掉。
      idleTimeout: 0,
      sendPings: false,
      open(ws) {
        connections.add(ws);
        if (!keepNewest(ws)) return;
        const { deviceId, name, webhook, auth } = ws.data;
        void queue.run(async () => {
          if (auth === "enrolled" && (await enroll.getActive(deviceId)) === undefined) {
            dropSocket(ws, 4001, "revoked");
            return;
          }
          await core.ensureWebhook(webhook, secret).catch(() => undefined);
          if (replaced.has(ws) || ws.readyState !== OPEN) return;
          await core.connected(deviceId, name);
        });
      },
      message(ws, message) {
        if (replaced.has(ws)) return;
        if (typeof message !== "string") return;
        // 心跳不进队列，避免被前面的 Telegram 调用堵住。
        if (message === "ping") {
          ws.send("pong");
          return;
        }
        const socket: DispatchSocket = {
          deviceId: ws.data.deviceId,
          name: ws.data.name,
          auth: ws.data.auth,
          send: (frame) => {
            if (ws.readyState === OPEN) ws.send(frame);
          },
        };
        void queue
          .run(async () => {
            if (replaced.has(ws) || ws.readyState !== OPEN) return;
            const handled = await dispatch.handleFrame(socket, message);
            if (!handled) await core.frame(socket, message);
          })
          .catch(() => undefined);
      },
      close(ws) {
        connections.delete(ws);
        // 被新连接踢掉或吊销主动关闭的 close 不能再广播「离线」，否则会盖住新连接。
        if (replaced.has(ws) || stopping) return;
        void queue
          .run(async () => {
            await dispatch.onDisconnect(ws.data.deviceId);
            await core.broadcast();
          })
          .catch(() => undefined);
      },
    },
  });

  const port = server.port;
  if (port === undefined) {
    dispatch.stop();
    await server.stop(true);
    throw new Error("中转没有拿到监听端口");
  }

  let stopped: Promise<void> | null = null;
  return {
    port,
    stop() {
      if (stopped) return stopped;
      stopping = true;
      dispatch.stop();
      stopped = (async () => {
        const halting = server.stop(true);
        let settled = false;
        let failure: unknown;
        const finished = halting.then(
          () => {
            settled = true;
          },
          (error: unknown) => {
            settled = true;
            failure = error ?? new Error("中转停止失败");
          },
        );
        await queue.drain();
        // Bun 1.3：服务端 close/terminate 之后 pendingWebSockets 不减少，stop() 的 Promise 不结束
        // （oven-sh/bun#36223，1.4 已修）。正常关掉时这里立刻往下走。
        const deadline = Date.now() + 500;
        while (!settled && Date.now() < deadline) await Bun.sleep(20);
        if (settled) {
          await finished;
          if (failure) throw failure;
        } else {
          server.unref();
        }
        await queue.drain();
        await auditLog.drain();
      })();
      return stopped;
    },
  };
}
