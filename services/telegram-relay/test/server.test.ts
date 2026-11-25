import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { startRelayServer, type RelayServer } from "../src/server.js";

const KEY = "relay-key-0123456789abcdef";
const TOKEN = "123456:TEST-TOKEN";
const DEVICE_A = "device-aaa-0001";
const DEVICE_B = "device-bbb-0002";
const OWNER = 1001;

interface TgCall {
  method: string;
  params: Record<string, unknown>;
  token: string;
}

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  pongs: number;
  closed: { code: number; reason: string } | null;
}

async function webhookSecret(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`u-brain-webhook:${key}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 8_000) throw new Error(`超时：${label}`);
    await Bun.sleep(10);
  }
}

function startTelegram(token: string, holdWebhook: Promise<void> | null = null) {
  const calls: TgCall[] = [];
  let webhook = "";
  let nextId = 1;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(url.pathname);
      if (!match) return new Response("not found", { status: 404 });
      const got = match[1] ?? "";
      const method = match[2] ?? "";
      const params = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ method, params, token: got });
      if (method === "getMe") return Response.json({ ok: true, result: { id: 77, username: "ub_bot", first_name: "UB" } });
      if (method === "getWebhookInfo") {
        if (holdWebhook) await holdWebhook;
        return Response.json({ ok: true, result: { url: webhook } });
      }
      if (method === "setWebhook") {
        webhook = typeof params.url === "string" ? params.url : "";
        return Response.json({ ok: true, result: true });
      }
      if (method === "sendMessage") {
        const text = typeof params.text === "string" ? params.text : "";
        if (text.includes("LEAK")) return Response.json({ ok: false, description: `rejected ${token}` });
        return Response.json({ ok: true, result: { message_id: nextId++ } });
      }
      return Response.json({ ok: false, description: `unknown ${method}` });
    },
  });
  return { server, calls, port: server.port ?? 0, webhook: () => webhook };
}

function openClient(port: number, key: string, device: string, name: string, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connect?device=${device}&name=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${key}`, ...headers },
    });
    const client: Client = { ws, frames: [], pongs: 0, closed: null };
    const timer = setTimeout(() => reject(new Error(`连不上 ${device}`)), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(client);
    });
    ws.addEventListener("message", (event) => {
      if (event.data === "pong") {
        client.pongs += 1;
        return;
      }
      if (typeof event.data === "string") client.frames.push(JSON.parse(event.data) as Record<string, unknown>);
    });
    ws.addEventListener("close", (event) => {
      client.closed = { code: event.code, reason: event.reason };
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket 失败 ${device}`));
    });
  });
}

let nextReq = 0;

async function request(client: Client, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `r${(nextReq += 1)}`;
  client.ws.send(JSON.stringify({ t: "req", id, ...body }));
  await waitFor(() => client.frames.some((frame) => frame.t === "res" && frame.id === id), `响应 ${id}`);
  return client.frames.find((frame) => frame.id === id)!;
}

function stateFrames(client: Client): Array<Record<string, unknown>> {
  return client.frames.filter((frame) => frame.t === "state");
}

async function withRelay(key = KEY, token = TOKEN) {
  const dir = await mkdtemp(join(tmpdir(), "ub-relay-"));
  const telegram = startTelegram(token);
  const relay = await startRelayServer({
    port: 0,
    host: "127.0.0.1",
    botToken: token,
    relayKey: key,
    dataDir: dir,
    telegramApi: `http://127.0.0.1:${telegram.port}`,
  });
  const clients: Client[] = [];
  return {
    dir,
    relay,
    telegram,
    base: `http://127.0.0.1:${relay.port}`,
    secret: await webhookSecret(key),
    async connect(device: string, name: string, headers: Record<string, string> = {}) {
      const client = await openClient(relay.port, key, device, name, headers);
      clients.push(client);
      return client;
    },
    async stop() {
      for (const client of clients) {
        try {
          client.ws.close();
        } catch {
          // 已经关了。
        }
      }
      await relay.stop();
      await telegram.server.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("Bun relay server", () => {
  it("鉴权、webhook secret、/check 和首页", async () => {
    const world = await withRelay();
    try {
      const wrong = await fetch(`${world.base}/check`, { headers: { Authorization: "Bearer not-the-real-key" } });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ ok: false });

      const forbidden = await fetch(`${world.base}/telegram`, {
        method: "POST",
        headers: { [ "X-Telegram-Bot-Api-Secret-Token" ]: "nope" },
        body: "{}",
      });
      expect(forbidden.status).toBe(403);

      const check = await fetch(`${world.base}/check`, { headers: { Authorization: `Bearer ${KEY}` } });
      expect(await check.json()).toEqual({ ok: true, botConfigured: true });

      const ignored = await fetch(`${world.base}/telegram`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": world.secret },
        body: "not-json",
      });
      expect(ignored.status).toBe(200);
      expect(await ignored.text()).toBe("ok");

      expect(await (await fetch(world.base)).text()).toBe("U-Brain Telegram relay\n");
      expect((await fetch(`${world.base}/missing`)).status).toBe(404);

      const badDevice = await fetch(`${world.base}/connect?device=short&name=A`, {
        headers: {
          Authorization: `Bearer ${KEY}`,
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      expect(badDevice.status).toBe(400);
    } finally {
      await world.stop();
    }
  });

  it("已入网设备用自己的令牌换邀请码，新设备用它入网；没令牌和限速都拒绝", async () => {
    const world = await withRelay();
    try {
      const adminInvite = await fetch(`${world.base}/admin/invite`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } });
      const first = (await adminInvite.json()) as { code: string };
      const keyOf = () => {
        const { publicKey } = generateKeyPairSync("ed25519");
        return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url");
      };
      const enrolled = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: first.code, deviceId: DEVICE_A, name: "Mac A", publicKey: keyOf() }),
      });
      const { token } = (await enrolled.json()) as { token: string };
      expect(token).toMatch(/^ubd_/);

      // 没令牌、旧共享密钥都不行。
      expect((await fetch(`${world.base}/invite`, { method: "POST" })).status).toBe(401);
      expect((await fetch(`${world.base}/invite`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(401);

      const issued = await fetch(`${world.base}/invite`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      expect(issued.status).toBe(200);
      const { code, url } = (await issued.json()) as { code: string; url: string };
      // 中转告诉设备自己的对外地址：没配固定地址时用请求的 origin。
      expect(url).toBe(world.base);
      const joined = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, deviceId: DEVICE_B, name: "Mac B", publicKey: keyOf() }),
      });
      expect(joined.status).toBe(200);
      // 邀请码一次性。
      const reuse = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, deviceId: "device-ccc-0003", name: "Mac C", publicKey: keyOf() }),
      });
      expect(reuse.status).not.toBe(200);

      // 每小时 30 个。
      let limited = 0;
      for (let index = 0; index < 34; index += 1) {
        const response = await fetch(`${world.base}/invite`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        if (response.status === 429) limited += 1;
      }
      expect(limited).toBeGreaterThan(0);
    } finally {
      await world.stop();
    }
  });

  it("密钥少于 16 位时 /check 和 /connect 一律 401", async () => {
    const world = await withRelay("short-key");
    try {
      const check = await fetch(`${world.base}/check`, { headers: { Authorization: "Bearer short-key" } });
      expect(check.status).toBe(401);
      const connect = await fetch(`${world.base}/connect?device=${DEVICE_A}&name=A`, {
        headers: {
          Authorization: "Bearer short-key",
          Upgrade: "websocket",
          Connection: "Upgrade",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
        },
      });
      expect(connect.status).toBe(401);
    } finally {
      await world.stop();
    }
  });

  it("两台设备互相看见，重连踢旧连接，ping 不进队列", async () => {
    let releaseWebhook: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseWebhook = resolve;
    });
    const dir = await mkdtemp(join(tmpdir(), "ub-relay-"));
    const telegram = startTelegram(TOKEN, hold);
    let relay: RelayServer | null = null;
    const clients: Client[] = [];
    try {
      relay = await startRelayServer({
        port: 0,
        botToken: TOKEN,
        relayKey: KEY,
        dataDir: dir,
        telegramApi: `http://127.0.0.1:${telegram.port}`,
      });
      const first = await openClient(relay.port, KEY, DEVICE_A, "MacBook");
      clients.push(first);
      first.ws.send("ping");
      await waitFor(() => first.pongs === 1, "pong");
      releaseWebhook();
      await waitFor(() => stateFrames(first).length > 0, "第一台状态");

      const second = await openClient(relay.port, KEY, DEVICE_B, "Mini");
      clients.push(second);
      await waitFor(() => {
        const frame = stateFrames(second).at(-1);
        const devices = frame?.devices as Array<{ id: string; online: boolean }> | undefined;
        return devices?.length === 2 && devices.every((device) => device.online);
      }, "两台都在线");
      const seen = stateFrames(first).at(-1)?.devices as Array<{ id: string; online: boolean }>;
      expect(seen.map((device) => device.id).sort()).toEqual([DEVICE_A, DEVICE_B]);

      const mark = second.frames.length;
      const again = await openClient(relay.port, KEY, DEVICE_A, "MacBook");
      clients.push(again);
      await waitFor(() => first.closed?.code === 4000, "旧连接关闭码");
      expect(first.closed?.reason).toBe("replaced");
      await waitFor(() => second.frames.slice(mark).some((frame) => frame.t === "state"), "重连后的状态");
      const later = second.frames.slice(mark).filter((frame) => frame.t === "state");
      expect(later.length).toBeGreaterThan(0);
      for (const frame of later) {
        const devices = frame.devices as Array<{ id: string; online: boolean }>;
        expect(devices.find((device) => device.id === DEVICE_A)?.online).toBe(true);
      }
      expect(telegram.webhook()).toBe(`http://127.0.0.1:${relay.port}/telegram`);
      expect(telegram.calls.filter((call) => call.method === "setWebhook")).toHaveLength(1);
    } finally {
      releaseWebhook();
      for (const client of clients) {
        try {
          client.ws.close();
        } catch {
          // 已经关了。
        }
      }
      await relay?.stop();
      await telegram.server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("并发 send 不丢路由，回复只回到对应设备，重启后状态还在", async () => {
    const world = await withRelay();
    try {
      const mac = await world.connect(DEVICE_A, "MacBook");
      const mini = await world.connect(DEVICE_B, "Mini");
      await waitFor(() => stateFrames(mac).some((frame) => (frame.devices as unknown[]).length === 2), "两台在线");

      const paired = await request(mac, { op: "pair" });
      const code = (paired.result as { code: string }).code;
      const posted = await fetch(`${world.base}/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": world.secret },
        body: JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            chat: { id: OWNER, type: "private" },
            from: { id: OWNER, username: "owner" },
            text: `/start ${code}`,
          },
        }),
      });
      expect(posted.status).toBe(200);
      await waitFor(() => stateFrames(mac).some((frame) => frame.bound !== null && frame.bound !== undefined), "已绑定");

      const pending: Array<Promise<Record<string, unknown>>> = [];
      for (let index = 0; index < 50; index += 1) {
        pending.push(request(mac, { op: "send", text: `a${index}`, push: true }));
        pending.push(request(mini, { op: "send", text: `b${index}`, push: true }));
      }
      const results = await Promise.all(pending);
      expect(results.every((frame) => frame.ok === true)).toBe(true);

      const file = join(world.dir, "state.json");
      const saved = JSON.parse(await Bun.file(file).text()) as {
        routes: Array<[number, string]>;
        chat: { id: number };
        devices: Record<string, { name: string }>;
      };
      expect(saved.routes).toHaveLength(100);
      expect(saved.routes.filter(([, id]) => id === DEVICE_A)).toHaveLength(50);
      expect(saved.routes.filter(([, id]) => id === DEVICE_B)).toHaveLength(50);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(file).text()).not.toContain(TOKEN);
      expect(await Bun.file(file).text()).not.toContain(KEY);

      const fromMac = results[0]!.result as { messageId: number };
      const beforeMini = mini.frames.filter((frame) => frame.t === "message").length;
      const reply = await fetch(`${world.base}/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": world.secret },
        body: JSON.stringify({
          update_id: 2,
          message: {
            message_id: 2,
            chat: { id: OWNER, type: "private" },
            from: { id: OWNER, username: "owner" },
            text: "只给 Mac",
            reply_to_message: { message_id: fromMac.messageId },
          },
        }),
      });
      expect(reply.status).toBe(200);
      await waitFor(() => mac.frames.some((frame) => frame.t === "message" && (frame.message as { text?: string }).text === "只给 Mac"), "Mac 收到回复");
      expect(mini.frames.filter((frame) => frame.t === "message").length).toBe(beforeMini);

      const dir = world.dir;
      await world.relay.stop();
      const restarted = await startRelayServer({
        port: 0,
        botToken: TOKEN,
        relayKey: KEY,
        dataDir: dir,
        telegramApi: `http://127.0.0.1:${world.telegram.port}`,
      });
      try {
        const back = await openClient(restarted.port, KEY, DEVICE_A, "MacBook");
        await waitFor(() => stateFrames(back).some((frame) => (frame.bound as { name?: string } | null)?.name === "@owner"), "重启后仍绑定");
        const devices = stateFrames(back).at(-1)?.devices as Array<{ id: string; name: string }>;
        expect(devices.map((device) => device.id).sort()).toEqual([DEVICE_A, DEVICE_B]);
        const again = JSON.parse(await Bun.file(file).text()) as { routes: unknown[]; chat: { id: number } };
        expect(again.routes).toHaveLength(100);
        expect(again.chat.id).toBe(OWNER);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        back.ws.close();
      } finally {
        await restarted.stop();
      }
    } finally {
      await world.stop();
    }
  }, 20_000);

  it("损坏的 state.json 会备份并从空状态启动", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-relay-"));
    const telegram = startTelegram(TOKEN);
    await writeFile(join(dir, "state.json"), "{", { mode: 0o644 });
    const relay = await startRelayServer({
      port: 0,
      botToken: TOKEN,
      relayKey: KEY,
      dataDir: dir,
      telegramApi: `http://127.0.0.1:${telegram.port}`,
    });
    try {
      const names = await readdir(dir);
      expect(names.some((name) => /^state\.json\.corrupt-\d+$/u.test(name))).toBe(true);
      const check = await fetch(`http://127.0.0.1:${relay.port}/check`, { headers: { Authorization: `Bearer ${KEY}` } });
      expect(check.status).toBe(200);
    } finally {
      await relay.stop();
      await telegram.server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Telegram 错误信息里的 token 会被换成 <token>", async () => {
    const world = await withRelay();
    try {
      const mac = await world.connect(DEVICE_A, "MacBook");
      await waitFor(() => stateFrames(mac).length > 0, "在线");
      const paired = await request(mac, { op: "pair" });
      const code = (paired.result as { code: string }).code;
      await fetch(`${world.base}/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": world.secret },
        body: JSON.stringify({
          update_id: 1,
          message: {
            message_id: 1,
            chat: { id: OWNER, type: "private" },
            from: { id: OWNER, username: "owner" },
            text: `/start ${code}`,
          },
        }),
      });
      await waitFor(() => stateFrames(mac).some((frame) => frame.bound !== null && frame.bound !== undefined), "已绑定");
      const failed = await request(mac, { op: "send", text: "LEAK", push: true });
      expect(failed.ok).toBe(false);
      expect(failed.error).toContain("<token>");
      expect(String(failed.error)).not.toContain(TOKEN);
    } finally {
      await world.stop();
    }
  });

  it("配置了固定公网地址时 webhook 直接用它", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-relay-"));
    const telegram = startTelegram(TOKEN);
    const relay = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      botToken: TOKEN,
      relayKey: KEY,
      dataDir: dir,
      telegramApi: `http://127.0.0.1:${telegram.port}`,
      publicOrigin: "https://relay.example.com/",
    });
    try {
      const client = await openClient(relay.port, KEY, DEVICE_A, "MacBook", {});
      try {
        await waitFor(() => telegram.calls.some((call) => call.method === "setWebhook"), "setWebhook");
        expect(telegram.webhook()).toBe("https://relay.example.com/telegram");
      } finally {
        client.ws.close();
      }
    } finally {
      await relay.stop();
      telegram.server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("配置了固定公网地址时 /invite 返回它，经回环地址申请的设备也能把可用地址写进云盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-relay-"));
    const telegram = startTelegram(TOKEN);
    const relay = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      botToken: TOKEN,
      relayKey: KEY,
      dataDir: dir,
      telegramApi: `http://127.0.0.1:${telegram.port}`,
      publicOrigin: "https://relay.example.com/",
    });
    try {
      const base = `http://127.0.0.1:${relay.port}`;
      const adminInvite = (await (await fetch(`${base}/admin/invite`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } })).json()) as { code: string };
      const { publicKey } = generateKeyPairSync("ed25519");
      const enrolled = await fetch(`${base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: adminInvite.code,
          deviceId: DEVICE_A,
          name: "VPS",
          publicKey: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url"),
        }),
      });
      const { token } = (await enrolled.json()) as { token: string };
      const issued = (await (await fetch(`${base}/invite`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).json()) as { url: string };
      expect(issued.url).toBe("https://relay.example.com");
    } finally {
      await relay.stop();
      telegram.server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("反代声明 https 时 webhook 用 https", async () => {
    const world = await withRelay();
    try {
      await world.connect(DEVICE_A, "MacBook", { "X-Forwarded-Proto": "https" });
      await waitFor(() => world.telegram.calls.some((call) => call.method === "setWebhook"), "setWebhook");
      expect(world.telegram.webhook()).toBe(`https://127.0.0.1:${world.relay.port}/telegram`);
    } finally {
      await world.stop();
    }
  });

  it("已入网设备经 WebSocket 发 notify、收 t:push 与 pushes 增量补拉，并在未配 BOT_TOKEN 时零 Telegram 请求且屏蔽旧绑定状态", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-relay-"));
    // 模拟之前启用过 Telegram 后留下的旧状态，清空 BOT_TOKEN 重启后应立即隐藏 bot/bound 且不请求 Telegram API。
    await writeFile(
      join(dir, "state.json"),
      JSON.stringify({
        bot: { id: 77, username: "old_bot", name: "Old" },
        chat: { id: OWNER, name: "@owner" },
      }),
    );
    const telegram = startTelegram(TOKEN);
    const relay = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      botToken: "",
      relayKey: KEY,
      dataDir: dir,
      telegramApi: `http://127.0.0.1:${telegram.port}`,
      routerDeviceId: DEVICE_A,
    });
    const clients: Client[] = [];
    try {
      const base = `http://127.0.0.1:${relay.port}`;
      const checkRes = await fetch(`${base}/check`, { headers: { Authorization: `Bearer ${KEY}` } });
      expect(await checkRes.json()).toEqual({ ok: true, botConfigured: false });

      const tgWebhookRes = await fetch(`${base}/telegram`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": await webhookSecret(KEY) },
        body: "{}",
      });
      expect(tgWebhookRes.status).toBe(404);

      const enroll = async (deviceId: string, name: string) => {
        const inv = (await (await fetch(`${base}/admin/invite`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` } })).json()) as { code: string };
        const { publicKey } = generateKeyPairSync("ed25519");
        const res = await fetch(`${base}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: inv.code,
            deviceId,
            name,
            publicKey: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url"),
          }),
        });
        return ((await res.json()) as { token: string }).token;
      };
      const tokA = await enroll(DEVICE_A, "VPS");
      const tokB = await enroll(DEVICE_B, "Android");
      const cA = await openClient(relay.port, tokA, DEVICE_A, "VPS");
      const cB = await openClient(relay.port, tokB, DEVICE_B, "Android");
      clients.push(cA, cB);

      await waitFor(() => stateFrames(cB).some((s) => s.routerDeviceId === DEVICE_A), "routerDeviceId in state");
      const latestState = stateFrames(cB).at(-1)!;
      expect(latestState.bot).toBeNull();
      expect(latestState.bound).toBeNull();

      const notifyRes = await request(cA, {
        op: "notify",
        kind: "tty7",
        status: "waiting",
        title: "终端等你回复",
        body: "Continue? [y/N]",
        replyToken: "rt-1",
        telegramText: "⏳ Continue?",
      });
      expect(notifyRes.ok).toBe(true);
      expect(notifyRes.result).toEqual({ seq: 1, messageId: null });

      await waitFor(() => cB.frames.some((f) => f.t === "push"), "push broadcast");
      const pushFrame = cB.frames.find((f) => f.t === "push")!;
      expect((pushFrame.item as { title: string; replyToken: string }).title).toBe("终端等你回复");
      expect((pushFrame.item as { replyToken: string }).replyToken).toBe("rt-1");

      const pull = await request(cB, { op: "pushes", sinceSeq: 0, limit: 10 });
      expect(pull.ok).toBe(true);
      expect((pull.result as { latestSeq: number; items: unknown[] }).latestSeq).toBe(1);
      expect((pull.result as { items: unknown[] }).items).toHaveLength(1);

      expect(telegram.calls).toEqual([]);
    } finally {
      for (const client of clients) client.ws.close();
      await relay.stop();
      telegram.server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

