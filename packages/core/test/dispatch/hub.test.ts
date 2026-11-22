import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HelloDispatch } from "@you-brain/protocol";

import { MemorySecretStore } from "../../src/auth/secret-store.js";
import type { T3ThreadBrief } from "../../src/deck/t3/automation.js";
import type { DispatchRelayFrame } from "../../src/deck/telegram/relay.js";
import {
  DeviceIdentity,
  DispatchExecutor,
  DispatchHub,
  type DispatchT3Port,
  type OutboxEntry,
} from "../../src/dispatch/index.js";
import { FakeRelay } from "./fake-relay.js";

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
  for (let index = 0; index < 200; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${label}`);
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "yb-dispatch-hub-"));
  dirs.push(dir);
  return dir;
}

async function makeNode(options: {
  deviceId: string;
  deviceName: string;
  withExecutor?: boolean;
  now?: () => number;
  timeoutMs?: number;
  dataDir?: string;
  store?: MemorySecretStore;
  onEvent?: (entry: OutboxEntry, event: { kind: string; data: unknown }) => void;
}) {
  const dir = options.dataDir ?? (await makeTempDir());
  const store = options.store ?? new MemorySecretStore(null);
  const identity = new DeviceIdentity({ store });
  const { publicKey } = await identity.ensure();
  const t3 = new FakeT3();
  let hub!: DispatchHub;
  const executor =
    options.withExecutor === false
      ? null
      : new DispatchExecutor({
          dataDir: dir,
          deviceId: options.deviceId,
          ...(options.now ? { now: options.now } : {}),
          t3,
          emitEvent: (to, frame) => hub.emitEvent(to, frame),
        });
  let seq = 0;
  hub = new DispatchHub({
    dataDir: dir,
    deviceId: options.deviceId,
    deviceName: options.deviceName,
    identity,
    executor,
    ...(options.now ? { now: options.now } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    newId: () => `id-${++seq}`,
  });
  return { dir, store, identity, publicKey, t3, executor, hub };
}

describe("DispatchHub", () => {
  test("1. A 把项目 X 的 t3.start 派给 B：返回 threadId、A outbox 为 running、B 账本有记录", async () => {
    let now = 1_760_000_000_000;
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false, now: () => now });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B", now: () => now });

    await b.executor!.updatePolicy({
      enabled: true,
      maxMode: "auto",
      allowedSenders: [{ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey }],
      allowedProjects: ["p1"],
    });

    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });
    await until(() => relay.hellos.some((h) => h.from === "dev-b"), "b hello");

    const list = a.hub.devices();
    expect(list.find((d) => d.id === "dev-a")?.self).toBe(true);
    expect(list.find((d) => d.id === "dev-b")?.dispatch?.enabled).toBe(true);
    expect(list.find((d) => d.id === "dev-b")?.dispatch?.projects).toEqual([{ id: "p1", name: "you-brain" }]);

    const started = await a.hub.startThread("dev-b", {
      projectId: "p1",
      title: "修 Bug",
      prompt: "排查并修复",
      mode: "full-access",
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.threadId).toBe("thread-1");
    expect(started.mode).toBe("auto");
    expect(started.capped).toBe(true);

    const outboxEntry = await a.hub.getOutbox(started.dispatchId);
    expect(outboxEntry).toMatchObject({
      dispatchId: started.dispatchId,
      to: "dev-b",
      deviceName: "Mac B",
      projectId: "p1",
      title: "修 Bug",
      mode: "auto",
      threadId: "thread-1",
      status: "running",
    });

    const ledger = JSON.parse(await readFile(join(b.dir, "dispatch", "ledger.json"), "utf8")) as {
      dispatches: Record<string, { threadId: string; from: string; projectId: string }>;
    };
    expect(ledger.dispatches[started.dispatchId]).toMatchObject({
      threadId: "thread-1",
      from: "dev-a",
      projectId: "p1",
    });
  });

  test("2. B 策略未开启：A 得到「本机没有开启接收派活」，outbox 为 failed，B 的 T3 一次未调", async () => {
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B" });

    // B 默认策略 enabled: false
    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });
    await until(() => relay.hellos.length >= 2, "hellos");
    b.t3.calls = 0;

    const started = await a.hub.startThread("dev-b", {
      projectId: "p1",
      title: "任务",
      prompt: "执行",
    });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error).toBe("本机没有开启接收派活");
    expect(b.t3.calls).toBe(0);

    const entry = await a.hub.getOutbox(started.dispatchId);
    expect(entry).toMatchObject({ status: "failed", error: "本机没有开启接收派活" });
  });

  test("3. 目标离线：立即失败不等超时；无 link 时返回「还没连上中转」", async () => {
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false, timeoutMs: 5_000 });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B" });

    const noLink = await a.hub.dispatch("dev-b", "t3.projects", {});
    expect(noLink).toEqual({ ok: false, error: "还没连上中转" });

    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });
    relay.disconnect("dev-b");

    const t0 = Date.now();
    const res = await a.hub.dispatch("dev-b", "t3.projects", {});
    expect(res).toEqual({ ok: false, error: "目标设备不在线" });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("4. 超时与同 cmdId 重试：换新 nonce 重签，命中 B 幂等不重复建会话；startThread 内部重试复用 cmdId/dispatchId", async () => {
    let now = 1_760_000_000_000;
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false, now: () => now, timeoutMs: 40 });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B", now: () => now });
    await b.executor!.updatePolicy({
      enabled: true,
      allowedSenders: [{ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey }],
      allowedProjects: ["p1"],
    });
    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });

    // (a) 假中转吞掉 cmd -> 超时；再以同一 cmdId 重试（换新 nonce）-> 成功；再重试一次命中 B 幂等不重复建会话
    relay.dropCmdCount = 1;
    const args = { projectId: "p1", title: "幂等任务", prompt: "只建一次", dispatchId: "d-idem" };
    const first = await a.hub.dispatch("dev-b", "t3.start", args, { cmdId: "c-idem", timeoutMs: 30 });
    expect(first).toEqual({ ok: false, error: "等待目标设备结果超时" });
    expect(b.t3.launches).toHaveLength(0);

    const second = await a.hub.dispatch("dev-b", "t3.start", args, { cmdId: "c-idem", timeoutMs: 500 });
    expect(second.ok).toBe(true);
    expect(b.t3.launches).toHaveLength(1);

    const third = await a.hub.dispatch("dev-b", "t3.start", args, { cmdId: "c-idem", timeoutMs: 500 });
    expect(third).toEqual(second);
    expect(b.t3.launches).toHaveLength(1);

    // 确认三次用了相同 cmdId 但不同 nonce
    const idemCmds = relay.sentCmds.filter((c) => c.cmdId === "c-idem");
    expect(idemCmds).toHaveLength(3);
    expect(new Set(idemCmds.map((c) => c.nonce)).size).toBe(3);

    // (b) startThread 首次返回 cmdres 被丢弃（B 已创建会话）-> 内部重试复用同一个 cmdId 和 dispatchId -> 命中幂等成功
    relay.dropCmdresCount = 1;
    const beforeLaunches = b.t3.launches.length;
    const started = await a.hub.startThread(
      "dev-b",
      { projectId: "p1", title: "自动重试", prompt: "只建一次" },
      { timeoutMs: 40 },
    );
    expect(started.ok).toBe(true);
    expect(b.t3.launches).toHaveLength(beforeLaunches + 1);
    if (!started.ok) return;
    const retryCmds = relay.sentCmds.filter((c) => c.cmdId === started.entry.cmdId);
    expect(retryCmds).toHaveLength(2);
    expect(retryCmds[0]!.nonce).not.toBe(retryCmds[1]!.nonce);
  });

  test("5. B 会话状态变化推 event 更新 A 的 outbox 并调 onEvent；伪造 event 被丢弃", async () => {
    const relay = new FakeRelay();
    const received: Array<{ entry: OutboxEntry; event: { kind: string; data: unknown } }> = [];
    const a = await makeNode({
      deviceId: "dev-a",
      deviceName: "Mac A",
      withExecutor: false,
      onEvent: (entry, event) => received.push({ entry, event }),
    });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B" });
    await b.executor!.updatePolicy({
      enabled: true,
      allowedSenders: [{ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey }],
      allowedProjects: ["p1"],
    });
    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });

    const started = await a.hub.startThread("dev-b", { projectId: "p1", title: "观察", prompt: "跑起来" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // 第一次 tick 建基线
    await b.executor!.tick();
    expect(received).toHaveLength(0);

    // B 会话变为 completed -> A outbox 更新为 done 且触发 onEvent
    b.t3.threads.get(started.threadId)!.status = "completed";
    await b.executor!.tick();
    await until(() => received.length === 1, "event delivered");

    expect(received[0]!.entry.status).toBe("done");
    expect(received[0]!.event.kind).toBe("thread.status");
    expect((await a.hub.getOutbox(started.dispatchId))?.status).toBe("done");

    // 伪造的 event（from 不是目标设备 / dispatchId 不存在）被丢弃
    a.hub.onFrame({
      t: "event",
      from: "dev-evil",
      dispatchId: started.dispatchId,
      kind: "thread.status",
      data: { threadId: started.threadId, status: "failed", previous: "completed", title: "观察", link: null },
    });
    a.hub.onFrame({
      t: "event",
      from: "dev-b",
      dispatchId: "d-nonexistent",
      kind: "thread.status",
      data: { threadId: "thread-x", status: "failed", previous: "running", title: "x", link: null },
    });
    // 给微任务/队列一个回合确认未被误处理
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    expect((await a.hub.getOutbox(started.dispatchId))?.status).toBe("done");
  });

  test("6. read 与 followup 经 B 账本校验往返并同步 outbox", async () => {
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B" });
    await b.executor!.updatePolicy({
      enabled: true,
      allowedSenders: [{ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey }],
      allowedProjects: ["p1"],
    });
    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });

    const started = await a.hub.startThread("dev-b", { projectId: "p1", title: "读写", prompt: "开始" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const row = b.t3.threads.get(started.threadId)!;
    row.state = "ready";
    row.summary = "已完成全部检查";

    const read = await a.hub.read(started.dispatchId);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state).toBe("ready");
    expect(read.summary).toBe("已完成全部检查");
    expect((await a.hub.getOutbox(started.dispatchId))?.status).toBe("done");
    expect((await a.hub.getOutbox(started.dispatchId))?.lastSummary).toBe("已完成全部检查");

    const followed = await a.hub.followup(started.dispatchId, "再补个测试");
    expect(followed).toEqual({ ok: true, dispatchId: started.dispatchId, threadId: started.threadId });
    expect(b.t3.followups).toHaveLength(1);
    expect(b.t3.followups[0]).toMatchObject({ threadId: started.threadId, prompt: "再补个测试" });
    expect((await a.hub.getOutbox(started.dispatchId))?.status).toBe("running");

    // 账本外的 threadId 走底层 dispatch 会被 B 拒绝
    const outsider = await a.hub.dispatch("dev-b", "t3.read", { threadId: "thread-outside" });
    expect(outsider).toEqual({ ok: false, error: "找不到这个派活会话" });
  });

  test("7. 同一 cmdId 并发到达两次，B 只执行一次", async () => {
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B" });
    await b.executor!.updatePolicy({
      enabled: true,
      allowedSenders: [{ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey }],
      allowedProjects: ["p1"],
    });
    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });

    let release!: () => void;
    b.t3.launchGate = () => new Promise<void>((resolve) => { release = resolve; });

    const fields = {
      cmdId: "c-concurrent",
      from: "dev-a",
      to: "dev-b",
      ts: Date.now(),
      nonce: "nonce-concurrent-1",
      cmd: {
        kind: "t3.start",
        args: { projectId: "p1", title: "并发", prompt: "执行一次", dispatchId: "d-concurrent" },
      },
    };
    const sig = await a.identity.sign(fields);
    const frame: DispatchRelayFrame = { t: "cmd", ...fields, sig };

    relay.pending.set("c-concurrent", { from: "dev-a", to: "dev-b" });
    b.hub.onFrame(frame);
    b.hub.onFrame(frame);

    await until(() => release !== undefined, "entered launchThread");
    release();

    await until(() => relay.sentResults.some((r) => r.cmdId === "c-concurrent"), "result sent");
    expect(b.t3.launches).toHaveLength(1);
    expect(relay.sentResults.filter((r) => r.cmdId === "c-concurrent")).toHaveLength(1);
  });

  test("8. attach(null) 立即失败等待者；attach 发 hello，策略变更后 refreshHello 再发", async () => {
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false, timeoutMs: 5_000 });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B" });
    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });

    await until(() => relay.hellos.some((h) => h.from === "dev-b"), "initial hello");
    expect((relay.hellos.findLast((h) => h.from === "dev-b")?.dispatch as HelloDispatch).enabled).toBe(false);

    await b.executor!.updatePolicy({ enabled: true, allowedProjects: ["p1", "p2"], maxMode: "full-access" });
    await b.hub.refreshHello();
    const latest = relay.hellos.findLast((h) => h.from === "dev-b")?.dispatch as HelloDispatch;
    expect(latest.enabled).toBe(true);
    expect(latest.maxMode).toBe("full-access");
    expect(latest.projects.map((p) => p.id)).toEqual(["p1", "p2"]);

    // 吞掉 cmd 让 A 挂起等待，随后 attach(null) -> 立刻以断开失败
    relay.dropCmdCount = 1;
    const waiting = a.hub.dispatch("dev-b", "t3.projects", {}, { timeoutMs: 10_000 });
    await until(() => relay.sentCmds.length === 1, "cmd sent");
    const t0 = Date.now();
    a.hub.attach(null);
    expect(await waiting).toEqual({ ok: false, error: "和中转的连接断开了" });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  test("9. outbox 权限 0600、重启后保留、超 30 天清理、损坏自动备份并从空开始", async () => {
    let now = 1_760_000_000_000;
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false, now: () => now });
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B", now: () => now });
    await b.executor!.updatePolicy({
      enabled: true,
      allowedSenders: [{ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey }],
      allowedProjects: ["p1"],
    });
    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });

    const started = await a.hub.startThread("dev-b", { projectId: "p1", title: "持久化", prompt: "干活" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const outboxPath = join(a.dir, "dispatch", "outbox.json");
    expect((await stat(outboxPath)).mode & 0o777).toBe(0o600);

    // 模拟重启（新 hub 同 dataDir）
    const restarted = await makeNode({
      deviceId: "dev-a",
      deviceName: "Mac A",
      withExecutor: false,
      dataDir: a.dir,
      store: a.store,
      now: () => now,
    });
    const list = await restarted.hub.outbox();
    expect(list).toHaveLength(1);
    expect(list[0]!.dispatchId).toBe(started.dispatchId);

    // 超过 30 天后自动清理
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await restarted.hub.outbox()).toEqual([]);
    expect(await restarted.hub.getOutbox(started.dispatchId)).toBeNull();

    // 损坏文件：备份为 *.corrupt-<时间戳> 并从空开始
    await writeFile(outboxPath, "{not valid json", "utf8");
    const afterCorrupt = await makeNode({
      deviceId: "dev-a",
      deviceName: "Mac A",
      withExecutor: false,
      dataDir: a.dir,
      store: a.store,
      now: () => now,
    });
    expect(await afterCorrupt.hub.outbox()).toEqual([]);
    const files = await readdir(join(a.dir, "dispatch"));
    expect(files.some((name) => name.startsWith("outbox.json.corrupt-"))).toBe(true);
  });

  test("无 executor 的目标端回「本机不接受派活」，结果超 256KB 回「结果过大」", async () => {
    const relay = new FakeRelay();
    const a = await makeNode({ deviceId: "dev-a", deviceName: "Mac A", withExecutor: false });
    const initiatorOnly = await makeNode({ deviceId: "dev-c", deviceName: "VPS", withExecutor: false });
    relay.connect({ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey, hub: a.hub });
    relay.connect({ deviceId: "dev-c", name: "VPS", publicKey: initiatorOnly.publicKey, hub: initiatorOnly.hub });

    const refused = await a.hub.dispatch("dev-c", "t3.projects", {});
    expect(refused).toEqual({ ok: false, error: "本机不接受派活" });

    // 超大结果（>256KB）：构造一个返回巨大项目列表的 B
    const b = await makeNode({ deviceId: "dev-b", deviceName: "Mac B" });
    const hugeProjects = Array.from({ length: 400 }, (_, i) => ({
      id: `p-${i}`,
      name: "甲".repeat(300),
      cwd: `/repo/${i}`,
    }));
    b.t3.projectsImpl = hugeProjects;
    await b.executor!.updatePolicy({
      enabled: true,
      allowedSenders: [{ deviceId: "dev-a", name: "Mac A", publicKey: a.publicKey }],
      allowedProjects: hugeProjects.map((p) => p.id),
    });
    relay.connect({ deviceId: "dev-b", name: "Mac B", publicKey: b.publicKey, hub: b.hub });

    const oversized = await a.hub.dispatch("dev-b", "t3.projects", {});
    expect(oversized).toEqual({ ok: false, error: "结果过大" });
  });
});
