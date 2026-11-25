import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startRelayServer, type RelayServer } from "../../../../services/telegram-relay/src/server.js";
import { MemorySecretStore } from "../../src/auth/secret-store.js";
import type { T3ThreadBrief } from "../../src/deck/t3/automation.js";
import { enrollRelay, TelegramRelayClient } from "../../src/deck/telegram/relay.js";
import { DeviceIdentity, DispatchExecutor, DispatchHub, type DispatchT3Port } from "../../src/dispatch/index.js";

/**
 * 跨层验证：真实 Bun 中转（services/telegram-relay）+ 真实设备客户端（TelegramRelayClient）+ 真实 DispatchHub/Executor，
 * 只有 Telegram 与 T3 是假的。证明「入网 → hello → 签名 cmd → 目标端验签执行 → result/event 回传」整条链路接得上。
 */

const RELAY_KEY = "relay-key-0123456789abcdef";

interface ThreadRow {
  title: string;
  status: string;
  link: string | null;
  state: "planning" | "running" | "ready" | "failed";
  summary: string;
  error?: string;
}

class FakeT3 implements DispatchT3Port {
  calls = 0;
  launches: Array<{ projectId: string; title: string; prompt: string; requestId: string; runtimeMode: string }> = [];
  followups: Array<{ threadId: string; prompt: string; commandId: string }> = [];
  projectsImpl = [
    { id: "p1", name: "you-brain", cwd: "/repo" },
    { id: "p2", name: "other", cwd: "/other" },
  ];
  threads = new Map<string, ThreadRow>();
  launchGate: (() => Promise<void>) | null = null;
  hugeSummary = false;

  async projects(): Promise<Array<{ id: string; name: string; cwd: string }>> {
    this.calls += 1;
    return this.projectsImpl;
  }

  async launchThread(input: {
    projectId: string;
    title: string;
    prompt: string;
    requestId: string;
    runtimeMode: "auto-accept-edits" | "auto" | "full-access";
  }): Promise<{ threadId: string; threadUrl: string }> {
    this.calls += 1;
    if (this.launchGate) await this.launchGate();
    this.launches.push(input);
    const threadId = `thread-${this.launches.length}`;
    this.threads.set(threadId, {
      title: input.title,
      status: "running",
      link: `https://t3.example/${threadId}`,
      state: "running",
      summary: "",
    });
    return { threadId, threadUrl: `http://127.0.0.1:3773/env/${threadId}` };
  }

  async followup(threadId: string, prompt: string, commandId: string): Promise<void> {
    this.calls += 1;
    this.followups.push({ threadId, prompt, commandId });
  }

  async inspect(threadId: string): Promise<{ state: "planning" | "running" | "ready" | "failed"; summary: string; error?: string }> {
    this.calls += 1;
    const thread = this.threads.get(threadId);
    if (!thread) return { state: "failed", summary: "", error: "不存在" };
    if (thread.error !== undefined) return { state: thread.state, summary: thread.summary, error: thread.error };
    return { state: thread.state, summary: thread.summary };
  }

  async threadStates(): Promise<T3ThreadBrief[]> {
    this.calls += 1;
    return [...this.threads.entries()].map(([threadId, thread]) => ({
      threadId,
      title: thread.title,
      status: thread.status,
      latestRunId: null,
      snoozed: false,
      link: thread.link,
    }));
  }

  async latestAnswer(): Promise<string> {
    this.calls += 1;
    return "";
  }
}


async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let index = 0; index < 600; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label}`);
}

function startFakeTelegram() {
  let webhook = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(new URL(request.url).pathname);
      if (!match) return new Response("not found", { status: 404 });
      const params = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (match[2] === "getMe") return Response.json({ ok: true, result: { id: 77, username: "ub_bot", first_name: "UB" } });
      if (match[2] === "getWebhookInfo") return Response.json({ ok: true, result: { url: webhook } });
      if (match[2] === "setWebhook") {
        webhook = typeof params.url === "string" ? params.url : "";
        return Response.json({ ok: true, result: true });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  return server;
}

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yb-relay-e2e-"));
  dirs.push(dir);
  return dir;
}

async function makeDevice(
  relayUrl: string,
  deviceId: string,
  name: string,
  withExecutor: boolean,
  t3Url?: string,
  /** 复用已入网设备的数据目录、身份与令牌，模拟这台设备的 daemon 重启。 */
  restart?: { dir: string; identity: DeviceIdentity; token: string },
) {
  const dir = restart?.dir ?? (await tmp());
  const identity = restart?.identity ?? new DeviceIdentity({ store: new MemorySecretStore(null) });
  const { publicKey } = await identity.ensure();
  let token = restart?.token;
  if (!token) {
    const invite = await fetch(`${relayUrl}/admin/invite`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RELAY_KEY}` },
    });
    const { code } = (await invite.json()) as { code: string };
    token = (await enrollRelay(relayUrl, { code, deviceId, name, publicKey })).token;
  }

  const t3 = new FakeT3();
  let hub!: DispatchHub;
  const executor = withExecutor
    ? new DispatchExecutor({ dataDir: dir, deviceId, t3, emitEvent: (to, frame) => hub.emitEvent(to, frame) })
    : null;
  hub = new DispatchHub({
    dataDir: dir,
    deviceId,
    deviceName: name,
    identity,
    executor,
    t3Tunnel: { localUrl: async () => t3Url ?? "http://127.0.0.1:1/", pairCredential: async () => "one-time" },
  });
  const client: TelegramRelayClient = new TelegramRelayClient({
    url: relayUrl,
    token,
    deviceId,
    name,
    onState: (state) => hub.setState(state),
    onMessage: () => undefined,
    onConnection: (status) => {
      if (status === "ok") hub.attach(client);
    },
    onDispatchFrame: (frame) => hub.onFrame(frame),
  });
  client.start();
  cleanups.push(() => client.stop());
  return { hub, executor, t3, publicKey, token, client, identity, dir };
}

const BIG_BODY = crypto.getRandomValues(new Uint8Array(700 * 1024 + 123));
const BIG_JS = Array.from({ length: 40_000 }, (_, index) => `export const v${index} = ${index * 7};`).join("\n");

describe("真实中转 + 真实设备端：派活全链路", () => {
  test("A 经真实中转把任务派给 B，B 状态变化后 A 的 outbox 更新；撤销 B 后再派失败", async () => {
    const telegram = startFakeTelegram();
    cleanups.push(() => telegram.stop(true));
    const relayData = await tmp();
    const relay: RelayServer = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      botToken: "123456:TEST-TOKEN",
      relayKey: RELAY_KEY,
      dataDir: relayData,
      telegramApi: `http://127.0.0.1:${telegram.port}`,
    });
    cleanups.push(() => relay.stop());
    const url = `http://127.0.0.1:${relay.port}`;

    const a = await makeDevice(url, "device-aaa-0001", "Mac A", false);
    const b = await makeDevice(url, "device-bbb-0002", "Mac B", true);
    await b.executor!.updatePolicy({
      enabled: true,
      maxMode: "auto",
      allowedSenders: [{ deviceId: "device-aaa-0001", name: "Mac A", publicKey: a.publicKey }],
      allowedProjects: ["p1"],
    });
    await b.hub.refreshHello();

    await until(() => a.hub.devices().find((d) => d.id === "device-bbb-0002")?.dispatch?.enabled === true, "A 看到 B 已开启接收");
    expect(a.hub.devices().find((d) => d.id === "device-bbb-0002")?.dispatch?.projects).toEqual([{ id: "p1", name: "you-brain" }]);

    const started = await a.hub.startThread("device-bbb-0002", { projectId: "p1", title: "跨层派活", prompt: "做点事" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.threadId).toBe("thread-1");
    expect(b.t3.launches).toHaveLength(1);
    expect(b.t3.launches[0]?.prompt).toBe("做点事");

    // B 的会话做完：执行器 15 秒才轮询一次，这里手动 tick——第一次建立 running 基线，改状态后第二次才会发事件
    await b.executor!.tick();
    b.t3.threads.get("thread-1")!.status = "ready";
    b.t3.threads.get("thread-1")!.state = "ready";
    b.t3.threads.get("thread-1")!.summary = "已完成";
    await b.executor!.tick();
    await until(async () => (await a.hub.getOutbox(started.dispatchId))?.status === "done", "A 的 outbox 收到事件变为 done");
    const read = await a.hub.read(started.dispatchId);
    expect(read.ok).toBe(true);

    // 目标策略关闭后，A 被拒绝，B 的 T3 没有新会话
    await b.executor!.updatePolicy({ enabled: false });
    const rejected = await a.hub.dispatch("device-bbb-0002", "t3.projects", {});
    expect(rejected.ok).toBe(false);
    expect(b.t3.launches).toHaveLength(1);

    // 吊销 B：中转立即踢掉连接，A 再派立刻失败（目标离线）
    const revoke = await fetch(`${url}/admin/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RELAY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "device-bbb-0002" }),
    });
    expect(revoke.status).toBe(200);
    await until(() => a.hub.devices().find((d) => d.id === "device-bbb-0002")?.online === false, "B 下线");
    const offline = await a.hub.dispatch("device-bbb-0002", "t3.projects", {});
    expect(offline.ok).toBe(false);
  }, 30_000);

  test("T3 隧道：A 经真实中转看 B 的 T3（密文转发）；B 没开放、没勾选 A、吊销后都不通", async () => {
    const telegram = startFakeTelegram();
    cleanups.push(() => telegram.stop(true));
    const relay: RelayServer = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      botToken: "123456:TEST-TOKEN",
      relayKey: RELAY_KEY,
      dataDir: await tmp(),
      telegramApi: `http://127.0.0.1:${telegram.port}`,
    });
    cleanups.push(() => relay.stop());
    const url = `http://127.0.0.1:${relay.port}`;

    const t3 = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/big") return new Response(BIG_BODY);
        if (path === "/app.js") return new Response(BIG_JS, { headers: { "content-type": "text/javascript" } });
        return new Response(`B 的 T3：${path}`, { headers: { "x-from": "t3" } });
      },
    });
    cleanups.push(() => t3.stop(true));

    const a = await makeDevice(url, "device-aaa-0001", "Mac A", true);
    const b = await makeDevice(url, "device-bbb-0002", "Mac B", true, `http://127.0.0.1:${t3.port}/`);
    await until(() => a.hub.devices().find((d) => d.id === "device-bbb-0002")?.online === true, "A 看到 B 在线");

    // 默认不开放
    await expect(a.hub.t3Tunnel("device-bbb-0002")).rejects.toThrow("本机没有开放 T3 查看");

    // 开了但没勾选 A
    await b.executor!.updatePolicy({ viewT3: true });
    await b.hub.refreshHello();
    await until(() => a.hub.devices().find((d) => d.id === "device-bbb-0002")?.dispatch?.viewT3 === true, "A 看到 B 开放了 T3");
    await expect(a.hub.t3Tunnel("device-bbb-0002")).rejects.toThrow();

    // 勾选 A 后通了
    await b.executor!.updatePolicy({ allowedSenders: [{ deviceId: "device-aaa-0001", name: "Mac A", publicKey: a.publicKey }] });
    const session = await a.hub.t3Tunnel("device-bbb-0002");
    const response = await session.fetch("/hello?x=1", { method: "GET", headers: [] });
    expect(await response.text()).toBe("B 的 T3：/hello");
    expect(response.headers.get("x-from")).toBe("t3");
    expect(await session.pair()).toBe("one-time");
    // 大响应（几百 KB，分多个满块帧）：帧超过中转上限会被丢，隧道就此卡死——真实中转上必须完整到达，且之后的请求仍然通
    const big = new Uint8Array(await (await session.fetch("/big", { method: "GET", headers: [] })).arrayBuffer());
    expect(big.length).toBe(BIG_BODY.length);
    expect(Buffer.from(big).equals(Buffer.from(BIG_BODY))).toBe(true);
    // 文本类资源经 gzip 传输，客户端收到的仍是原文。
    const js = await session.fetch("/app.js", { method: "GET", headers: [] });
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(await js.text()).toBe(BIG_JS);
    expect(await (await session.fetch("/after", { method: "GET", headers: [] })).text()).toBe("B 的 T3：/after");
    // 会话复用
    expect(await a.hub.t3Tunnel("device-bbb-0002")).toBe(session);

    // B 的 daemon 重启：会话表丢了。A 还拿着旧会话，下次请求由 B 回 reset 立即失败（不是等 60 秒超时），再取会话重新握手
    b.client.stop();
    await until(() => a.hub.devices().find((d) => d.id === "device-bbb-0002")?.online === false, "B 下线");
    await makeDevice(url, "device-bbb-0002", "Mac B", true, `http://127.0.0.1:${t3.port}/`, {
      dir: b.dir,
      identity: b.identity,
      token: b.token,
    });
    await until(() => a.hub.devices().find((d) => d.id === "device-bbb-0002")?.online === true, "B 重启后上线");
    const staleStarted = Date.now();
    await expect(session.fetch("/stale", { method: "GET", headers: [] })).rejects.toThrow("隧道已关闭");
    expect(Date.now() - staleStarted).toBeLessThan(5_000);
    const fresh = await a.hub.t3Tunnel("device-bbb-0002");
    expect(fresh).not.toBe(session);
    expect(await (await fresh.fetch("/again", { method: "GET", headers: [] })).text()).toBe("B 的 T3：/again");

    // 吊销 B 后，会话上的请求失败
    await fetch(`${url}/admin/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${RELAY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: "device-bbb-0002" }),
    });
    await until(() => a.hub.devices().find((d) => d.id === "device-bbb-0002")?.online === false, "B 下线");
    await expect(a.hub.t3Tunnel("device-bbb-0002").then((next) => next.fetch("/x", { method: "GET", headers: [] }))).rejects.toThrow();
  }, 30_000);
});
