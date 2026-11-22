import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import type { RelayAuditEntry } from "../src/audit.js";
import { DispatchRouter, type DispatchSocket } from "../src/dispatch.js";
import { startRelayServer, type RelayServerOptions } from "../src/server.js";

const KEY = "relay-key-0123456789abcdef";
const TOKEN = "123456:TEST-TOKEN";
const DEVICE_A = "device-aaa-0001";
const DEVICE_B = "device-bbb-0002";
const DEVICE_C = "device-ccc-0003";

interface Client {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: { code: number; reason: string } | null;
}

function genEd25519PublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
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

let nextReq = 0;

async function sendReq(client: Client, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `d${(nextReq += 1)}`;
  client.ws.send(JSON.stringify({ t: "req", id, ...body }));
  await waitFor(() => client.frames.some((frame) => frame.t === "res" && frame.id === id), `响应 ${id}`);
  return client.frames.find((frame) => frame.t === "res" && frame.id === id)!;
}

async function createWorld(overrides: Partial<RelayServerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ub-relay-dispatch-"));
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

  async function enrollDevice(deviceId: string, name: string): Promise<{ token: string; publicKey: string; code: string }> {
    const inv = (await (
      await fetch(`${base}/admin/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}` },
      })
    ).json()) as { code: string };
    const publicKey = genEd25519PublicKey();
    const res = await fetch(`${base}/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inv.code, deviceId, name, publicKey }),
    });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    return { token, publicKey, code: inv.code };
  }

  return {
    dir,
    relay,
    telegram,
    base,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    enrollDevice,
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

describe("设备间指令路由与 hello/state（集成）", () => {
  it("A→B 正常往返（from 由中转按身份填），审计文件 0600 且不含 args/result/token/邀请码", async () => {
    const world = await createWorld();
    try {
      const aCred = await world.enrollDevice(DEVICE_A, "Mac A");
      const bCred = await world.enrollDevice(DEVICE_B, "Mac B");
      const a = await world.connect(aCred.token, DEVICE_A, "Mac A");
      const b = await world.connect(bCred.token, DEVICE_B, "Mac B");
      await waitFor(() => a.frames.some((f) => f.t === "state"), "A 收到 state");
      await waitFor(() => b.frames.some((f) => f.t === "state"), "B 收到 state");

      const secretArg = "ARGS_SECRET_UNIQUE_9911";
      const secretResult = "RESULT_SECRET_UNIQUE_8822";

      // 故意在帧里放伪造的 from，中转必须以连接身份 DEVICE_A 覆盖
      const ack = await sendReq(a, {
        op: "cmd",
        cmdId: "cmd-roundtrip-1",
        from: "forged-device-id",
        to: DEVICE_B,
        cmd: { kind: "t3.start", args: { prompt: secretArg } },
        ts: world.now(),
        nonce: "nonce-rt-1",
        sig: "sig-rt-1",
      });
      expect(ack).toMatchObject({ ok: true, result: { accepted: true } });

      await waitFor(() => b.frames.some((f) => f.t === "cmd" && f.cmdId === "cmd-roundtrip-1"), "B 收到 cmd");
      const received = b.frames.find((f) => f.t === "cmd" && f.cmdId === "cmd-roundtrip-1")!;
      expect(received.from).toBe(DEVICE_A);
      expect(received.to).toBe(DEVICE_B);
      expect(received.cmd).toEqual({ kind: "t3.start", args: { prompt: secretArg } });
      expect(received.nonce).toBe("nonce-rt-1");
      expect(received.sig).toBe("sig-rt-1");

      const resAck = await sendReq(b, {
        op: "result",
        cmdId: "cmd-roundtrip-1",
        ok: true,
        result: { summary: secretResult },
      });
      expect(resAck).toMatchObject({ ok: true });

      await waitFor(() => a.frames.some((f) => f.t === "cmdres" && f.cmdId === "cmd-roundtrip-1"), "A 收到 cmdres");
      const cmdres = a.frames.find((f) => f.t === "cmdres" && f.cmdId === "cmd-roundtrip-1")!;
      expect(cmdres).toEqual({
        t: "cmdres",
        cmdId: "cmd-roundtrip-1",
        from: DEVICE_B,
        ok: true,
        result: { summary: secretResult },
      });

      // 同一 cmdId 第二次 result 被拒绝
      const dupResult = await sendReq(b, { op: "result", cmdId: "cmd-roundtrip-1", ok: true, result: {} });
      expect(dupResult.ok).toBe(false);

      // 审计：文件存在、权限 0600，绝不含 args / result / token / 邀请码
      const auditPath = join(world.dir, "audit.jsonl");
      expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
      const auditText = await readFile(auditPath, "utf8");
      expect(auditText).not.toContain(secretArg);
      expect(auditText).not.toContain(secretResult);
      expect(auditText).not.toContain(aCred.token);
      expect(auditText).not.toContain(bCred.token);
      expect(auditText).not.toContain(aCred.code);
      expect(auditText).not.toContain(bCred.code);
      expect(auditText).toContain('"kind":"t3.start"');
    } finally {
      await world.stop();
    }
  });

  it("目标离线立即失败且不排队；TTL 过期；nonce 重放；cmd 超大；result 超大", async () => {
    const world = await createWorld();
    try {
      const aCred = await world.enrollDevice(DEVICE_A, "Mac A");
      const bCred = await world.enrollDevice(DEVICE_B, "Mac B");
      const a = await world.connect(aCred.token, DEVICE_A, "Mac A");
      await waitFor(() => a.frames.some((f) => f.t === "state"), "A 在线");

      // 1) 目标离线立即失败，不排队
      const offlineRes = await sendReq(a, {
        op: "cmd",
        cmdId: "cmd-offline",
        to: DEVICE_B,
        cmd: { kind: "t3.projects", args: {} },
        ts: world.now(),
        nonce: "nonce-off-1",
        sig: "sig-off-1",
      });
      expect(offlineRes).toMatchObject({ ok: false, error: "目标设备不在线" });

      // 目标上线后不应补收离线期间失败的指令
      const b = await world.connect(bCred.token, DEVICE_B, "Mac B");
      await waitFor(() => b.frames.some((f) => f.t === "state"), "B 在线");
      expect(b.frames.some((f) => f.t === "cmd" && f.cmdId === "cmd-offline")).toBe(false);

      // 2) TTL 过期（超过 60 秒）
      const expiredRes = await sendReq(a, {
        op: "cmd",
        cmdId: "cmd-expired",
        to: DEVICE_B,
        cmd: { kind: "t3.projects", args: {} },
        ts: world.now() - 61_000,
        nonce: "nonce-exp-1",
        sig: "sig-exp-1",
      });
      expect(expiredRes.ok).toBe(false);

      // 3) nonce 重放：第一次成功，60 秒内重放同一 nonce 被拒
      const first = await sendReq(a, {
        op: "cmd",
        cmdId: "cmd-replay-1",
        to: DEVICE_B,
        cmd: { kind: "t3.projects", args: {} },
        ts: world.now(),
        nonce: "nonce-dup-1",
        sig: "sig-dup-1",
      });
      expect(first.ok).toBe(true);
      const replay = await sendReq(a, {
        op: "cmd",
        cmdId: "cmd-replay-2",
        to: DEVICE_B,
        cmd: { kind: "t3.projects", args: {} },
        ts: world.now(),
        nonce: "nonce-dup-1",
        sig: "sig-dup-2",
      });
      expect(replay.ok).toBe(false);

      // 4) cmd 超大（> 64 KB）
      const hugeCmd = await sendReq(a, {
        op: "cmd",
        cmdId: "cmd-huge",
        to: DEVICE_B,
        cmd: { kind: "t3.start", args: { prompt: "x".repeat(65 * 1024) } },
        ts: world.now(),
        nonce: "nonce-huge-1",
        sig: "sig-huge-1",
      });
      expect(hugeCmd.ok).toBe(false);

      // 5) result 超大（> 256 KB）-> 对发起方回 cmdres ok:false error:"结果过大"
      const forHugeResult = await sendReq(a, {
        op: "cmd",
        cmdId: "cmd-big-res",
        to: DEVICE_B,
        cmd: { kind: "t3.read", args: { threadId: "t1" } },
        ts: world.now(),
        nonce: "nonce-bigres-1",
        sig: "sig-bigres-1",
      });
      expect(forHugeResult.ok).toBe(true);
      await waitFor(() => b.frames.some((f) => f.t === "cmd" && f.cmdId === "cmd-big-res"), "B 收到 cmd-big-res");

      const bigResultAck = await sendReq(b, {
        op: "result",
        cmdId: "cmd-big-res",
        ok: true,
        result: { summary: "y".repeat(260 * 1024) },
      });
      expect(bigResultAck).toMatchObject({ ok: false, error: "结果过大" });
      await waitFor(() => a.frames.some((f) => f.t === "cmdres" && f.cmdId === "cmd-big-res"), "A 收到结果过大");
      expect(a.frames.find((f) => f.t === "cmdres" && f.cmdId === "cmd-big-res")).toEqual({
        t: "cmdres",
        cmdId: "cmd-big-res",
        from: DEVICE_B,
        ok: false,
        error: "结果过大",
      });
    } finally {
      await world.stop();
    }
  });

  it("非目标设备的 result 被丢弃；待结果超时；目标断线时待结果立刻失败", async () => {
    const world = await createWorld({ pendingTimeoutMs: 80 });
    try {
      const aCred = await world.enrollDevice(DEVICE_A, "Mac A");
      const bCred = await world.enrollDevice(DEVICE_B, "Mac B");
      const cCred = await world.enrollDevice(DEVICE_C, "Mac C");
      const a = await world.connect(aCred.token, DEVICE_A, "Mac A");
      const b = await world.connect(bCred.token, DEVICE_B, "Mac B");
      const c = await world.connect(cCred.token, DEVICE_C, "Mac C");
      await waitFor(() => a.frames.some((f) => f.t === "state") && b.frames.some((f) => f.t === "state") && c.frames.some((f) => f.t === "state"), "三台在线");

      // 1) 非目标设备 C 回传 A→B 的 result 被丢弃，B 仍可正常回传
      expect(
        (
          await sendReq(a, {
            op: "cmd",
            cmdId: "cmd-spoof",
            to: DEVICE_B,
            cmd: { kind: "t3.projects", args: {} },
            ts: world.now(),
            nonce: "n-spoof",
            sig: "s-spoof",
          })
        ).ok,
      ).toBe(true);
      const spoofRes = await sendReq(c, { op: "result", cmdId: "cmd-spoof", ok: true, result: { fake: true } });
      expect(spoofRes.ok).toBe(false);
      expect(a.frames.some((f) => f.t === "cmdres" && f.cmdId === "cmd-spoof")).toBe(false);

      expect((await sendReq(b, { op: "result", cmdId: "cmd-spoof", ok: true, result: { real: true } })).ok).toBe(true);
      await waitFor(() => a.frames.some((f) => f.t === "cmdres" && f.cmdId === "cmd-spoof"), "A 收到 B 的真实结果");
      expect(a.frames.find((f) => f.t === "cmdres" && f.cmdId === "cmd-spoof")).toMatchObject({
        ok: true,
        from: DEVICE_B,
        result: { real: true },
      });

      // 2) 待结果超时（80ms）
      expect(
        (
          await sendReq(a, {
            op: "cmd",
            cmdId: "cmd-timeout",
            to: DEVICE_B,
            cmd: { kind: "t3.projects", args: {} },
            ts: world.now(),
            nonce: "n-timeout",
            sig: "s-timeout",
          })
        ).ok,
      ).toBe(true);
      await waitFor(() => a.frames.some((f) => f.t === "cmdres" && f.cmdId === "cmd-timeout"), "A 收到超时 cmdres");
      expect(a.frames.find((f) => f.t === "cmdres" && f.cmdId === "cmd-timeout")).toEqual({
        t: "cmdres",
        cmdId: "cmd-timeout",
        from: DEVICE_B,
        ok: false,
        error: "目标设备没有返回结果",
      });

      // 3) 目标断线时待结果立刻失败
      expect(
        (
          await sendReq(a, {
            op: "cmd",
            cmdId: "cmd-drop",
            to: DEVICE_B,
            cmd: { kind: "t3.projects", args: {} },
            ts: world.now(),
            nonce: "n-drop",
            sig: "s-drop",
          })
        ).ok,
      ).toBe(true);
      await waitFor(() => b.frames.some((f) => f.t === "cmd" && f.cmdId === "cmd-drop"), "B 收到 cmd-drop");
      b.ws.close(1000, "bye");
      await waitFor(() => a.frames.some((f) => f.t === "cmdres" && f.cmdId === "cmd-drop"), "A 收到目标断开 cmdres");
      expect(a.frames.find((f) => f.t === "cmdres" && f.cmdId === "cmd-drop")).toEqual({
        t: "cmdres",
        cmdId: "cmd-drop",
        from: DEVICE_B,
        ok: false,
        error: "目标设备已断开",
      });
    } finally {
      await world.stop();
    }
  });

  it("限速第 31 条 cmd 失败；event 转发到在线目标、离线丢弃", async () => {
    const world = await createWorld();
    try {
      const aCred = await world.enrollDevice(DEVICE_A, "Mac A");
      const bCred = await world.enrollDevice(DEVICE_B, "Mac B");
      const a = await world.connect(aCred.token, DEVICE_A, "Mac A");
      const b = await world.connect(bCred.token, DEVICE_B, "Mac B");
      await waitFor(() => a.frames.some((f) => f.t === "state") && b.frames.some((f) => f.t === "state"), "AB 在线");

      // 发送 30 条均受理，第 31 条失败
      for (let i = 1; i <= 30; i += 1) {
        const res = await sendReq(a, {
          op: "cmd",
          cmdId: `cmd-rate-${i}`,
          to: DEVICE_B,
          cmd: { kind: "t3.projects", args: {} },
          ts: world.now(),
          nonce: `n-rate-${i}`,
          sig: `s-rate-${i}`,
        });
        expect(res.ok).toBe(true);
      }
      const over = await sendReq(a, {
        op: "cmd",
        cmdId: "cmd-rate-31",
        to: DEVICE_B,
        cmd: { kind: "t3.projects", args: {} },
        ts: world.now(),
        nonce: "n-rate-31",
        sig: "s-rate-31",
      });
      expect(over.ok).toBe(false);

      // event 转发到在线目标
      const evOnline = await sendReq(b, {
        op: "event",
        to: DEVICE_A,
        dispatchId: "disp-1",
        kind: "thread.status",
        data: { threadId: "th-1", status: "ready", previous: "running", title: "T", link: null },
      });
      expect(evOnline).toMatchObject({ ok: true, result: { delivered: true } });
      await waitFor(() => a.frames.some((f) => f.t === "event" && f.dispatchId === "disp-1"), "A 收到 event");
      expect(a.frames.find((f) => f.t === "event" && f.dispatchId === "disp-1")).toEqual({
        t: "event",
        from: DEVICE_B,
        dispatchId: "disp-1",
        kind: "thread.status",
        data: { threadId: "th-1", status: "ready", previous: "running", title: "T", link: null },
      });

      // event 离线丢弃
      const evOffline = await sendReq(b, {
        op: "event",
        to: DEVICE_C,
        dispatchId: "disp-offline",
        kind: "thread.status",
        data: { threadId: "th-2", status: "ready", previous: null, title: "T2", link: null },
      });
      expect(evOffline).toMatchObject({ ok: true, result: { delivered: false } });
    } finally {
      await world.stop();
    }
  });

  it("hello 与 state：state.devices[].dispatch 出现、离线保留最后一次、publicKey 仅已入网设备出现", async () => {
    const world = await createWorld();
    try {
      const aCred = await world.enrollDevice(DEVICE_A, "Mac A");
      const bCred = await world.enrollDevice(DEVICE_B, "Mac B");
      const a = await world.connect(aCred.token, DEVICE_A, "Mac A");
      const b = await world.connect(bCred.token, DEVICE_B, "Mac B");
      const legacyC = await world.connect(KEY, DEVICE_C, "Legacy C");
      await waitFor(() => {
        const last = a.frames.filter((f) => f.t === "state").at(-1);
        return Array.isArray(last?.devices) && last.devices.length === 3;
      }, "三台都出现在 state");

      const dispatchPayload = {
        enabled: true,
        t3: { ready: true, version: "0.1.9" },
        projects: [{ id: "p1", name: "you-brain" }],
        maxMode: "auto",
      };
      const helloRes = await sendReq(b, {
        op: "hello",
        protocolVersion: 1,
        version: "0.2.0",
        dispatch: dispatchPayload,
      });
      expect(helloRes.ok).toBe(true);

      await waitFor(() => {
        const last = a.frames.filter((f) => f.t === "state").at(-1);
        const devices = (last?.devices ?? []) as Array<Record<string, unknown>>;
        return devices.find((d) => d.id === DEVICE_B)?.dispatch !== undefined;
      }, "state 包含 B 的 dispatch");

      const state1 = a.frames.filter((f) => f.t === "state").at(-1)!;
      const devices1 = state1.devices as Array<Record<string, unknown>>;
      const devA1 = devices1.find((d) => d.id === DEVICE_A)!;
      const devB1 = devices1.find((d) => d.id === DEVICE_B)!;
      const devC1 = devices1.find((d) => d.id === DEVICE_C)!;
      expect(devA1.enrolled).toBe(true);
      expect(devA1.publicKey).toBe(aCred.publicKey);
      expect(devA1.dispatch).toBeUndefined();
      expect(devB1.enrolled).toBe(true);
      expect(devB1.publicKey).toBe(bCred.publicKey);
      expect(devB1.dispatch).toEqual(dispatchPayload);
      expect(devC1.enrolled).toBe(false);
      expect(devC1.publicKey).toBeUndefined();
      expect(devC1.dispatch).toBeUndefined();

      // B 下线后，state 里保留最后一次 dispatch 且 online: false
      const mark = a.frames.length;
      b.ws.close(1000, "bye");
      await waitFor(() => {
        const later = a.frames.slice(mark).filter((f) => f.t === "state");
        return later.some((f) => {
          const d = (f.devices as Array<Record<string, unknown>>).find((item) => item.id === DEVICE_B);
          return d?.online === false;
        });
      }, "B 下线广播");
      const state2 = a.frames.filter((f) => f.t === "state").at(-1)!;
      const devB2 = (state2.devices as Array<Record<string, unknown>>).find((d) => d.id === DEVICE_B)!;
      expect(devB2.online).toBe(false);
      expect(devB2.enrolled).toBe(true);
      expect(devB2.publicKey).toBe(bCred.publicKey);
      expect(devB2.dispatch).toEqual(dispatchPayload);

      // hello 超过 8 KB 被拒
      const bigHello = await sendReq(a, {
        op: "hello",
        protocolVersion: 1,
        dispatch: {
          enabled: true,
          t3: { ready: true },
          projects: [{ id: "p", name: "n".repeat(9000) }],
          maxMode: "auto",
        },
      });
      expect(bigHello.ok).toBe(false);
      legacyC.ws.close();
    } finally {
      await world.stop();
    }
  });
});

describe("DispatchRouter 纯逻辑单元测试", () => {
  it("event 目标限速 120 条/分钟，第 121 条被拒，60 秒后恢复", async () => {
    let clock = 5_000_000;
    const audits: RelayAuditEntry[] = [];
    const receivedA: Array<Record<string, unknown>> = [];
    const receivedB: Array<Record<string, unknown>> = [];
    const sockA: DispatchSocket = {
      deviceId: DEVICE_A,
      name: "A",
      auth: "enrolled",
      send: (frame) => receivedA.push(JSON.parse(frame) as Record<string, unknown>),
    };
    const sockB: DispatchSocket = {
      deviceId: DEVICE_B,
      name: "B",
      auth: "enrolled",
      send: (frame) => receivedB.push(JSON.parse(frame) as Record<string, unknown>),
    };
    const router = new DispatchRouter({
      sockets: () => [sockA, sockB],
      now: () => clock,
      audit: (entry) => void audits.push(entry),
      broadcast: () => undefined,
    });

    for (let i = 1; i <= 120; i += 1) {
      await router.handleFrame(
        sockB,
        JSON.stringify({
          t: "req",
          id: `ev-${i}`,
          op: "event",
          to: DEVICE_A,
          dispatchId: "d1",
          kind: "thread.status",
          data: { i },
        }),
      );
    }
    expect(receivedB.every((f) => f.ok === true)).toBe(true);
    expect(receivedA.filter((f) => f.t === "event")).toHaveLength(120);

    // 第 121 条被拒
    await router.handleFrame(
      sockB,
      JSON.stringify({
        t: "req",
        id: "ev-121",
        op: "event",
        to: DEVICE_A,
        dispatchId: "d1",
        kind: "thread.status",
        data: { i: 121 },
      }),
    );
    expect(receivedB.find((f) => f.id === "ev-121")?.ok).toBe(false);
    expect(audits.at(-1)?.outcome).toBe("rejected:rate_limited");

    // 60 秒后窗口滑过，恢复发送
    clock += 60_001;
    await router.handleFrame(
      sockB,
      JSON.stringify({
        t: "req",
        id: "ev-122",
        op: "event",
        to: DEVICE_A,
        dispatchId: "d1",
        kind: "thread.status",
        data: { i: 122 },
      }),
    );
    expect(receivedB.find((f) => f.id === "ev-122")?.ok).toBe(true);
    router.stop();
  });
});
