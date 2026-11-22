import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { runAdminCli } from "../src/admin.js";
import { RelayAuditLog } from "../src/audit.js";
import { startRelayServer, type RelayServerOptions } from "../src/server.js";

const KEY = "relay-key-0123456789abcdef";
const TOKEN = "123456:TEST-TOKEN";
const DEVICE_A = "device-aaa-0001";
const DEVICE_B = "device-bbb-0002";

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: { code: number; reason: string } | null;
}

function genEd25519PublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url");
}

function genRsaPublicKey(): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64url");
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 8_000) throw new Error(`超时：${label}`);
    await Bun.sleep(10);
  }
}

function startTelegram() {
  let webhook = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(url.pathname);
      if (!match) return new Response("not found", { status: 404 });
      const method = match[2] ?? "";
      const params = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (method === "getMe") return Response.json({ ok: true, result: { id: 77, username: "ub_bot", first_name: "UB" } });
      if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: webhook } });
      if (method === "setWebhook") {
        webhook = typeof params.url === "string" ? params.url : "";
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  return { server, port: server.port ?? 0 };
}

function openClient(port: number, bearer: string, device: string, name: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connect?device=${device}&name=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    const client: Client = { ws, frames: [], closed: null };
    const timer = setTimeout(() => reject(new Error(`连不上 ${device}`)), 5_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(client);
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data !== "pong") {
        client.frames.push(JSON.parse(event.data) as Record<string, unknown>);
      }
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

function wsHandshake(base: string, bearer: string, device: string): Promise<Response> {
  return fetch(`${base}/connect?device=${device}&name=Test`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    },
  });
}

let nextReq = 0;

async function sendReq(client: Client, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `e${(nextReq += 1)}`;
  client.ws.send(JSON.stringify({ t: "req", id, ...body }));
  await waitFor(() => client.frames.some((frame) => frame.t === "res" && frame.id === id), `响应 ${id}`);
  return client.frames.find((frame) => frame.t === "res" && frame.id === id)!;
}

async function createWorld(overrides: Partial<RelayServerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ub-relay-enroll-"));
  const telegram = startTelegram();
  let clock = 1_760_000_000_000;
  const relay = await startRelayServer({
    port: 0,
    host: "127.0.0.1",
    botToken: TOKEN,
    relayKey: KEY,
    dataDir: dir,
    telegramApi: `http://127.0.0.1:${telegram.port}`,
    now: () => clock,
    ...overrides,
  });
  const clients: Client[] = [];
  const base = `http://127.0.0.1:${relay.port}`;
  return {
    dir,
    relay,
    telegram,
    base,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    async invite(): Promise<{ code: string; expiresAt: string }> {
      const res = await fetch(`${base}/admin/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}` },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { code: string; expiresAt: string };
    },
    async connect(bearer: string, device: string, name: string) {
      const client = await openClient(relay.port, bearer, device, name);
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

describe("设备入网、邀请码、鉴权与管理端点", () => {
  it("邀请码：一次性兑换、二次使用失败、重复设备被拒、非 Ed25519/非法公钥 400", async () => {
    const world = await createWorld();
    try {
      const pkA = genEd25519PublicKey();
      const pkB = genEd25519PublicKey();
      const invite1 = await world.invite();
      expect(invite1.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/u);
      expect(new Date(invite1.expiresAt).getTime()).toBe(world.now() + 10 * 60_000);

      // 非法公钥 -> 400（不消耗邀请码）
      const badPk1 = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite1.code, deviceId: DEVICE_A, name: "Mac A", publicKey: "not+valid+base64url==" }),
      });
      expect(badPk1.status).toBe(400);

      const badPk2 = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite1.code, deviceId: DEVICE_A, name: "Mac A", publicKey: genRsaPublicKey() }),
      });
      expect(badPk2.status).toBe(400);

      // 首次兑换成功
      const ok = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite1.code.toLowerCase(), deviceId: DEVICE_A, name: "Mac A", publicKey: pkA }),
      });
      expect(ok.status).toBe(200);
      const { token } = (await ok.json()) as { token: string };
      expect(token).toMatch(/^ubd_[A-Za-z0-9_-]{43}$/u);

      // 第二次使用同一邀请码失败
      const reuse = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite1.code, deviceId: DEVICE_B, name: "Mac B", publicKey: pkB }),
      });
      expect(reuse.status).toBe(401);

      // 已存在设备用新邀请码重复入网被拒（409）
      const invite2 = await world.invite();
      const dup = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite2.code, deviceId: DEVICE_A, name: "Mac A 2", publicKey: pkB }),
      });
      expect(dup.status).toBe(409);

      // state.json 只存 tokenHash，不含明文 token
      const stateText = await readFile(join(world.dir, "state.json"), "utf8");
      expect(stateText).not.toContain(token);
      expect(stateText).toContain("tokenHash");

      // GET /admin/devices 不含 tokenHash
      const listRes = await fetch(`${world.base}/admin/devices`, { headers: { Authorization: `Bearer ${KEY}` } });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { devices: Array<Record<string, unknown>> };
      expect(listBody.devices).toHaveLength(1);
      expect(listBody.devices[0]?.deviceId).toBe(DEVICE_A);
      expect(listBody.devices[0]?.publicKey).toBe(pkA);
      expect(listBody.devices[0]?.tokenHash).toBeUndefined();

      // 审计日志存在、0600，不含令牌和邀请码
      const auditPath = join(world.dir, "audit.jsonl");
      expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
      const auditText = await readFile(auditPath, "utf8");
      expect(auditText).not.toContain(token);
      expect(auditText).not.toContain(invite1.code);
      expect(auditText).not.toContain(invite2.code);
      expect(auditText).toContain('"kind":"enroll"');
    } finally {
      await world.stop();
    }
  });

  it("邀请码过期失败，以及错误 5 次后全部作废（连正确码也失败）", async () => {
    const world = await createWorld();
    try {
      const pkA = genEd25519PublicKey();
      const pkB = genEd25519PublicKey();

      // 1) 过期测试
      const expiredInvite = await world.invite();
      world.advance(10 * 60_000 + 1);
      const expiredRes = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: expiredInvite.code, deviceId: DEVICE_A, name: "Mac A", publicKey: pkA }),
      });
      expect(expiredRes.status).toBe(401);

      // 2) 生成两个有效邀请码，连错 4 次后再成功兑换一个：重置计数但保留另一个有效码
      const valid1 = await world.invite();
      const valid2 = await world.invite();
      for (let i = 0; i < 3; i += 1) {
        const wrong = await fetch(`${world.base}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "WRONG234", deviceId: DEVICE_A, name: "Mac A", publicKey: pkA }),
        });
        expect(wrong.status).toBe(401);
      }
      // 第 1 次成功兑换（加上前面过期那 1 次总共失败 4 次 < 5，仍有效）
      const ok1 = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: valid1.code, deviceId: DEVICE_A, name: "Mac A", publicKey: pkA }),
      });
      expect(ok1.status).toBe(200);

      // 3) 现在连续错误 5 次 -> 剩余的 valid2 也全部作废
      for (let i = 0; i < 5; i += 1) {
        const wrong = await fetch(`${world.base}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "BADCODE2", deviceId: DEVICE_B, name: "Mac B", publicKey: pkB }),
        });
        expect(wrong.status).toBe(401);
      }
      const wiped = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: valid2.code, deviceId: DEVICE_B, name: "Mac B", publicKey: pkB }),
      });
      expect(wiped.status).toBe(401);
    } finally {
      await world.stop();
    }
  });

  it("鉴权与吊销：设备令牌可连、配错 device 拒、吊销立即 4001 且禁重连、acceptLegacyKey:false 拒旧密钥", async () => {
    const world = await createWorld();
    try {
      const pkA = genEd25519PublicKey();
      const invite = await world.invite();
      const enrolled = await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: invite.code, deviceId: DEVICE_A, name: "Mac A", publicKey: pkA }),
      });
      const { token } = (await enrolled.json()) as { token: string };

      // /check 接受设备令牌
      const checkRes = await fetch(`${world.base}/check`, { headers: { Authorization: `Bearer ${token}` } });
      expect(checkRes.status).toBe(200);
      expect(await checkRes.json()).toEqual({ ok: true, botConfigured: true });

      // 令牌配错 device 参数 -> 401
      const wrongDevice = await wsHandshake(world.base, token, DEVICE_B);
      expect(wrongDevice.status).toBe(401);

      // 设备令牌正常连上
      const clientA = await world.connect(token, DEVICE_A, "Mac A");
      await waitFor(() => clientA.frames.some((f) => f.t === "state"), "Mac A 收到 state");

      // legacy 连接可连（默认 acceptLegacyKey=true），但发 cmd/event/hello 得「请先入网」
      const legacyB = await world.connect(KEY, DEVICE_B, "Legacy B");
      await waitFor(() => legacyB.frames.some((f) => f.t === "state"), "Legacy B 收到 state");
      const legacyCmd = await sendReq(legacyB, {
        op: "cmd",
        cmdId: "c-legacy-1",
        to: DEVICE_A,
        cmd: { kind: "t3.projects", args: {} },
        ts: world.now(),
        nonce: "n1",
        sig: "s1",
      });
      expect(legacyCmd).toMatchObject({ ok: false, error: "请先入网" });
      const legacyHello = await sendReq(legacyB, {
        op: "hello",
        protocolVersion: 1,
        dispatch: { enabled: true, t3: { ready: true }, projects: [], maxMode: "auto" },
      });
      expect(legacyHello).toMatchObject({ ok: false, error: "请先入网" });
      const legacyEvent = await sendReq(legacyB, {
        op: "event",
        to: DEVICE_A,
        dispatchId: "d-1",
        kind: "thread.status",
        data: {},
      });
      expect(legacyEvent).toMatchObject({ ok: false, error: "请先入网" });

      // 吊销 Mac A：立即关闭码 4001 reason "revoked"，且无法再重连或 /check
      const revokeRes = await fetch(`${world.base}/admin/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: DEVICE_A }),
      });
      expect(revokeRes.status).toBe(200);
      await waitFor(() => clientA.closed?.code === 4001, "吊销关闭码 4001");
      expect(clientA.closed?.reason).toBe("revoked");

      expect((await wsHandshake(world.base, token, DEVICE_A)).status).toBe(401);
      expect((await fetch(`${world.base}/check`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);

      // 吊销后重启：吊销状态落盘，重启后仍无法用旧令牌连接
      const dir = world.dir;
      await world.relay.stop();
      const restarted = await startRelayServer({
        port: 0,
        host: "127.0.0.1",
        botToken: TOKEN,
        relayKey: KEY,
        dataDir: dir,
        telegramApi: `http://127.0.0.1:${world.telegram.port}`,
        acceptLegacyKey: false,
      });
      try {
        const base2 = `http://127.0.0.1:${restarted.port}`;
        // 重启后被吊销的令牌仍 401
        expect((await wsHandshake(base2, token, DEVICE_A)).status).toBe(401);
        // acceptLegacyKey: false 时旧密钥连不上 /connect 与 /check
        expect((await wsHandshake(base2, KEY, DEVICE_B)).status).toBe(401);
        expect((await fetch(`${base2}/check`, { headers: { Authorization: `Bearer ${KEY}` } })).status).toBe(401);
        // 但旧密钥仍可用于 /admin/*
        const invAfter = await fetch(`${base2}/admin/invite`, {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}` },
        });
        expect(invAfter.status).toBe(200);
        const { code: newCode } = (await invAfter.json()) as { code: string };
        // 吊销过的 DEVICE_A 可用新邀请码重新入网并连接
        const reEnroll = await fetch(`${base2}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: newCode, deviceId: DEVICE_A, name: "Mac A New", publicKey: genEd25519PublicKey() }),
        });
        expect(reEnroll.status).toBe(200);
        const { token: newToken } = (await reEnroll.json()) as { token: string };
        const back = await openClient(restarted.port, newToken, DEVICE_A, "Mac A New");
        await waitFor(() => back.frames.some((f) => f.t === "state"), "重启后新令牌连上");
        back.ws.close();
      } finally {
        await restarted.stop();
      }
    } finally {
      await world.stop();
    }
  });

  it("重启恢复：未吊销的已入网设备在重启后仍可用原令牌连接", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-relay-restart-"));
    const telegram = startTelegram();
    try {
      const relay1 = await startRelayServer({
        port: 0,
        botToken: TOKEN,
        relayKey: KEY,
        dataDir: dir,
        telegramApi: `http://127.0.0.1:${telegram.port}`,
      });
      const inv = (await (
        await fetch(`http://127.0.0.1:${relay1.port}/admin/invite`, {
          method: "POST",
          headers: { Authorization: `Bearer ${KEY}` },
        })
      ).json()) as { code: string };
      const { token } = (await (
        await fetch(`http://127.0.0.1:${relay1.port}/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: inv.code, deviceId: DEVICE_A, name: "Mac A", publicKey: genEd25519PublicKey() }),
        })
      ).json()) as { token: string };
      await relay1.stop();

      const relay2 = await startRelayServer({
        port: 0,
        botToken: TOKEN,
        relayKey: KEY,
        dataDir: dir,
        telegramApi: `http://127.0.0.1:${telegram.port}`,
        acceptLegacyKey: false,
      });
      try {
        const client = await openClient(relay2.port, token, DEVICE_A, "Mac A");
        await waitFor(() => client.frames.some((f) => f.t === "state"), "重启后旧令牌仍可连");
        client.ws.close();
      } finally {
        await relay2.stop();
      }
    } finally {
      await telegram.server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("admin 端点：带 X-Forwarded-For 或 Forwarded 一律 404，无/错密钥 401，CLI 正常工作且不泄露密钥", async () => {
    const world = await createWorld();
    try {
      // 带 X-Forwarded-For -> 404（即便密钥正确）
      const xff = await fetch(`${world.base}/admin/devices`, {
        headers: { Authorization: `Bearer ${KEY}`, "X-Forwarded-For": "1.2.3.4" },
      });
      expect(xff.status).toBe(404);

      // 带 Forwarded -> 404
      const fwd = await fetch(`${world.base}/admin/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, Forwarded: "for=1.2.3.4" },
      });
      expect(fwd.status).toBe(404);

      // 无密钥 / 错密钥 -> 401
      expect((await fetch(`${world.base}/admin/devices`)).status).toBe(401);
      expect(
        (await fetch(`${world.base}/admin/invite`, { method: "POST", headers: { Authorization: "Bearer wrong-key-01234567" } }))
          .status,
      ).toBe(401);

      // admin CLI: 缺 RELAY_KEY 报错退出
      const noKeyErr: string[] = [];
      const noKeyCode = await runAdminCli(["invite"], {}, { stderr: (line) => noKeyErr.push(line) });
      expect(noKeyCode).toBe(1);
      expect(noKeyErr.join("\n")).toContain("RELAY_KEY");

      // admin CLI: invite / devices / revoke
      const inviteOut: string[] = [];
      expect(
        await runAdminCli(
          ["invite"],
          { RELAY_KEY: KEY, RELAY_ADMIN_URL: world.base },
          { stdout: (line) => inviteOut.push(line), stderr: () => undefined },
        ),
      ).toBe(0);
      expect(inviteOut.join("\n")).toContain("邀请码：");
      expect(inviteOut.join("\n")).toContain("过期时间：");
      expect(inviteOut.join("\n")).not.toContain(KEY);

      const codeMatch = /邀请码：([A-Z2-9]{8})/u.exec(inviteOut.join("\n"));
      expect(codeMatch?.[1]).toBeTruthy();
      await fetch(`${world.base}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeMatch![1], deviceId: DEVICE_A, name: "Mac A", publicKey: genEd25519PublicKey() }),
      });

      const devicesOut: string[] = [];
      expect(
        await runAdminCli(
          ["devices"],
          { RELAY_KEY: KEY, RELAY_ADMIN_URL: world.base },
          { stdout: (line) => devicesOut.push(line) },
        ),
      ).toBe(0);
      expect(devicesOut.join("\n")).toContain(DEVICE_A);
      expect(devicesOut.join("\n")).not.toContain(KEY);

      const revokeOut: string[] = [];
      expect(
        await runAdminCli(
          ["revoke", DEVICE_A],
          { RELAY_KEY: KEY, RELAY_ADMIN_URL: world.base },
          { stdout: (line) => revokeOut.push(line) },
        ),
      ).toBe(0);
      expect(revokeOut.join("\n")).toContain(DEVICE_A);
    } finally {
      await world.stop();
    }
  });

  it("审计日志超过阈值时轮转为 audit.jsonl.1 且保持 0600 权限", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ub-relay-audit-"));
    try {
      const log = new RelayAuditLog(dir, 200);
      for (let i = 0; i < 6; i += 1) {
        await log.write({ ts: 1000 + i, from: DEVICE_A, to: DEVICE_B, kind: "t3.start", outcome: "accepted" });
      }
      const rotated = await readFile(join(dir, "audit.jsonl.1"), "utf8");
      const current = await readFile(join(dir, "audit.jsonl"), "utf8");
      expect(rotated.trim().split("\n").length).toBeGreaterThan(0);
      expect(current.trim().split("\n").length).toBeGreaterThan(0);
      expect((await stat(join(dir, "audit.jsonl"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
