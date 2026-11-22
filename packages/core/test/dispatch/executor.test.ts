import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateKeyPair, newNonce, signCommand, type CommandSigningFields, type RuntimeModeName } from "@you-brain/protocol";

import { T3AutomationError, type T3ThreadBrief } from "../../src/deck/t3/automation.js";
import {
  DispatchExecutor,
  defaultDispatchPolicy,
  type DispatchSender,
  type DispatchT3Port,
  type ThreadStatusEvent,
} from "../../src/dispatch/index.js";

const DEVICE_ID = "device-self";
const SENDER_ID = "device-peer";
const PROMPT = "PROMPT_9f3c1e7a_DO_NOT_LEAK";

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
  throwProjects = false;
  failLaunch = false;
  threads = new Map<string, ThreadRow>();
  outside: T3ThreadBrief | null = null;

  async projects(): Promise<Array<{ id: string; name: string; cwd: string }>> {
    this.calls += 1;
    if (this.throwProjects) throw new Error("t3 down");
    return this.projectsImpl;
  }

  async launchThread(input: { projectId: string; title: string; prompt: string; requestId: string; runtimeMode: "auto-accept-edits" | "auto" | "full-access" }): Promise<{ threadId: string; threadUrl: string }> {
    this.calls += 1;
    this.launches.push(input);
    if (this.failLaunch) throw new T3AutomationError("UNAVAILABLE", "无法连接 T3");
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
    const rows: T3ThreadBrief[] = [...this.threads.entries()].map(([threadId, thread]) => ({
      threadId,
      title: thread.title,
      status: thread.status,
      latestRunId: null,
      snoozed: false,
      link: thread.link,
    }));
    if (this.outside) rows.push(this.outside);
    return rows;
  }

  async latestAnswer(): Promise<string> {
    this.calls += 1;
    return "";
  }
}

interface HarnessOptions {
  enabled?: boolean;
  notify?: boolean;
  maxMode?: RuntimeModeName;
  projects?: string[];
  senders?: DispatchSender[];
  withNotify?: boolean;
}

interface Harness {
  dir: string;
  t3: FakeT3;
  executor: DispatchExecutor;
  events: Array<{ to: string; frame: ThreadStatusEvent }>;
  notifies: Array<{ fromName: string; projectName: string; title: string }>;
  keys: { publicKey: string; privateKey: string };
  other: { publicKey: string; privateKey: string };
  now: number;
  setNow(value: number): void;
  frame(overrides?: Partial<CommandSigningFields> & { privateKey?: string; sig?: string }): ReturnType<typeof signed>;
  close(): Promise<void>;
}

function signed(privateKey: string, fields: CommandSigningFields, sig?: string) {
  return { t: "cmd" as const, ...fields, sig: sig ?? signCommand(privateKey, fields) };
}

async function make(options: HarnessOptions = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "yb-dispatch-"));
  const keys = generateKeyPair();
  const other = generateKeyPair();
  const t3 = new FakeT3();
  const events: Harness["events"] = [];
  const notifies: Harness["notifies"] = [];
  let now = 1_760_000_000_000;
  const executor = new DispatchExecutor({
    dataDir: dir,
    deviceId: DEVICE_ID,
    now: () => now,
    t3,
    emitEvent: (to, frame) => events.push({ to, frame }),
    ...(options.withNotify === false ? {} : { notify: (info) => notifies.push(info) }),
  });
  const senders = options.senders ?? [{ deviceId: SENDER_ID, name: "Mac A", publicKey: keys.publicKey }];
  await executor.updatePolicy({
    enabled: options.enabled ?? true,
    notify: options.notify ?? true,
    maxMode: options.maxMode ?? "auto",
    allowedSenders: senders,
    allowedProjects: options.projects ?? ["p1"],
  });
  return {
    dir,
    t3,
    executor,
    events,
    notifies,
    keys,
    other,
    get now() { return now; },
    setNow(value: number) { now = value; },
    frame(overrides = {}) {
      const { privateKey, sig, ...rest } = overrides;
      const fields: CommandSigningFields = {
        cmdId: rest.cmdId ?? "c-1",
        from: rest.from ?? SENDER_ID,
        to: rest.to ?? DEVICE_ID,
        ts: rest.ts ?? now,
        nonce: rest.nonce ?? newNonce(),
        cmd: rest.cmd ?? {
          kind: "t3.start",
          args: { projectId: "p1", title: "标题", prompt: "做这件事", dispatchId: "d-1" },
        },
      };
      return signed(privateKey ?? keys.privateKey, fields, sig);
    },
    async close() {
      executor.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function track(harness: Harness): Harness {
  cleanups.push(() => harness.close());
  return harness;
}

describe("目标端执行器", () => {
  test("策略关闭时全部拒绝，审计有记录，不调用 T3", async () => {
    const h = track(await make({ enabled: false }));
    const start = await h.executor.handle(h.frame());
    const listed = await h.executor.handle(h.frame({
      cmdId: "c-2",
      cmd: { kind: "t3.threads", args: {} },
    }));
    expect(start).toEqual({ ok: false, error: "本机没有开启接收派活" });
    expect(listed).toEqual({ ok: false, error: "本机没有开启接收派活" });
    expect(h.t3.calls).toBe(0);
    const audit = await readFile(join(h.dir, "dispatch", "audit.jsonl"), "utf8");
    expect(audit).toContain("未开启");
    expect(audit.trim().split("\n").length).toBeGreaterThanOrEqual(2);
  });

  test("开启但发送方不在允许名单时拒绝", async () => {
    const h = track(await make());
    const result = await h.executor.handle(h.frame({ from: "device-stranger" }));
    expect(result).toEqual({ ok: false, error: "本机不接受这条指令" });
    expect(h.t3.launches).toHaveLength(0);
    expect(await readFile(join(h.dir, "dispatch", "audit.jsonl"), "utf8")).toContain("发送方未允许");
  });

  test("名单内但签名私钥或记录公钥不符时拒绝", async () => {
    const h = track(await make());
    const wrongKey = await h.executor.handle(h.frame({ privateKey: h.other.privateKey }));
    expect(wrongKey).toEqual({ ok: false, error: "本机不接受这条指令" });

    await h.executor.updatePolicy({
      allowedSenders: [{ deviceId: SENDER_ID, name: "Mac A", publicKey: h.other.publicKey }],
    });
    const wrongRecord = await h.executor.handle(h.frame({ cmdId: "c-2" }));
    expect(wrongRecord).toEqual({ ok: false, error: "本机不接受这条指令" });
    expect(h.t3.launches).toHaveLength(0);
    expect(await readFile(join(h.dir, "dispatch", "audit.jsonl"), "utf8")).toContain("验签失败");
  });

  test("过期 61 秒拒绝，60 秒内同一 nonce 重放拒绝", async () => {
    const h = track(await make());
    const late = await h.executor.handle(h.frame({ cmdId: "c-late", ts: h.now - 61_000 }));
    const early = await h.executor.handle(h.frame({ cmdId: "c-early", ts: h.now + 61_000 }));
    expect(late).toEqual({ ok: false, error: "本机不接受这条指令" });
    expect(early).toEqual({ ok: false, error: "本机不接受这条指令" });

    const nonce = newNonce();
    const accepted = await h.executor.handle(h.frame({ cmdId: "c-ok", nonce, ts: h.now - 60_000 }));
    expect(accepted.ok).toBe(true);
    const replay = await h.executor.handle(h.frame({ cmdId: "c-replay", nonce, ts: h.now }));
    expect(replay).toEqual({ ok: false, error: "本机不接受这条指令" });
    expect(h.t3.launches).toHaveLength(1);
    expect(await readFile(join(h.dir, "dispatch", "audit.jsonl"), "utf8")).toContain("nonce 重放");
  });

  test("项目不在白名单时拒绝", async () => {
    const h = track(await make());
    const result = await h.executor.handle(h.frame({
      cmd: { kind: "t3.start", args: { projectId: "p2", title: "标题", prompt: "做这件事", dispatchId: "d-2" } },
    }));
    expect(result).toEqual({ ok: false, error: "本机不接受这条指令" });
    expect(h.t3.launches).toHaveLength(0);
    expect(await readFile(join(h.dir, "dispatch", "audit.jsonl"), "utf8")).toContain("项目未允许");
  });

  test("白名单内创建会话一次，账本有记录，并通知", async () => {
    const h = track(await make());
    const result = await h.executor.handle(h.frame({
      cmd: { kind: "t3.start", args: { projectId: "p1", title: "标题", prompt: "做这件事", dispatchId: "d-1" } },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.result as { threadId: string; mode: string; capped: boolean };
    expect(h.t3.launches).toEqual([{
      projectId: "p1",
      title: "标题",
      prompt: "做这件事",
      requestId: "d-1",
      runtimeMode: "auto",
    }]);
    expect(value).toMatchObject({ threadId: "thread-1", mode: "auto", capped: false });
    expect(h.notifies).toEqual([{ fromName: "Mac A", projectName: "you-brain", title: "标题" }]);
    const ledger = JSON.parse(await readFile(join(h.dir, "dispatch", "ledger.json"), "utf8")) as {
      dispatches: Record<string, { threadId: string; from: string; projectId: string; title: string }>;
    };
    expect(ledger.dispatches["d-1"]).toMatchObject({
      threadId: "thread-1",
      from: SENDER_ID,
      projectId: "p1",
      title: "标题",
    });
  });

  test("请求 full-access 时按上限 auto 执行并标记 capped，approval-required 是参数错误", async () => {
    const h = track(await make({ maxMode: "auto" }));
    const capped = await h.executor.handle(h.frame({
      cmdId: "c-cap",
      cmd: {
        kind: "t3.start",
        args: { projectId: "p1", title: "标题", prompt: "做这件事", dispatchId: "d-cap", mode: "full-access" },
      },
    }));
    expect(capped).toMatchObject({ ok: true, result: { mode: "auto", capped: true } });
    expect(h.t3.launches[0]?.runtimeMode).toBe("auto");

    const rejected = await h.executor.handle(h.frame({
      cmdId: "c-bad-mode",
      cmd: {
        kind: "t3.start",
        args: { projectId: "p1", title: "标题", prompt: "做这件事", dispatchId: "d-bad", mode: "approval-required" },
      },
    }));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.startsWith("参数不对")).toBe(true);
    expect(h.t3.launches).toHaveLength(1);
  });

  test("同一 cmdId 或同一 dispatchId 都不重复建会话", async () => {
    const h = track(await make());
    const first = await h.executor.handle(h.frame({ cmdId: "c-1", cmd: startCmd("d-1") }));
    const sameCommand = await h.executor.handle(h.frame({ cmdId: "c-1", cmd: startCmd("d-1") }));
    const sameDispatch = await h.executor.handle(h.frame({ cmdId: "c-2", cmd: startCmd("d-1") }));
    expect(first).toEqual(sameCommand);
    expect(sameDispatch).toEqual(first);
    expect(h.t3.launches).toHaveLength(1);
    expect(h.notifies).toHaveLength(1);
  });

  test("read 和 followup 拒绝账本外的会话，账本内可以读和跟进", async () => {
    const h = track(await make());
    const started = await h.executor.handle(h.frame({ cmdId: "c-start", cmd: startCmd("d-1") }));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const threadId = (started.result as { threadId: string }).threadId;
    const missingRead = await h.executor.handle(h.frame({ cmdId: "c-read-miss", cmd: { kind: "t3.read", args: { threadId: "missing" } } }));
    const missingFollow = await h.executor.handle(h.frame({
      cmdId: "c-follow-miss",
      cmd: { kind: "t3.followup", args: { threadId: "missing", prompt: "继续", requestId: "r-miss" } },
    }));
    expect(missingRead).toEqual({ ok: false, error: "找不到这个派活会话" });
    expect(missingFollow).toEqual({ ok: false, error: "找不到这个派活会话" });
    expect(h.t3.followups).toHaveLength(0);

    const row = h.t3.threads.get(threadId);
    if (!row) throw new Error("missing thread");
    row.summary = "甲".repeat(32_100);
    row.state = "ready";
    const read = await h.executor.handle(h.frame({ cmdId: "c-read", cmd: { kind: "t3.read", args: { threadId } } }));
    expect(read).toMatchObject({
      ok: true,
      result: { state: "ready", link: `https://t3.example/${threadId}` },
    });
    if (!read.ok) return;
    expect((read.result as { summary: string }).summary).toHaveLength(32_000);

    const follow = await h.executor.handle(h.frame({
      cmdId: "c-follow",
      cmd: { kind: "t3.followup", args: { threadId, prompt: "继续做", requestId: "r-1" } },
    }));
    expect(follow).toEqual({ ok: true, result: {} });
    expect(h.t3.followups).toEqual([{ threadId, prompt: "继续做", commandId: "r-1" }]);

    const listed = await h.executor.handle(h.frame({ cmdId: "c-threads", cmd: { kind: "t3.threads", args: {} } }));
    expect(listed).toMatchObject({
      ok: true,
      result: {
        threads: [{ threadId, title: "标题", status: "running", link: `https://t3.example/${threadId}`, dispatchId: "d-1" }],
      },
    });
  });

  test("未知 kind 与缺字段都返回明确错误", async () => {
    const h = track(await make());
    const unknown = await h.executor.handle(h.frame({ cmd: { kind: "t3.nope", args: {} } }));
    const missing = await h.executor.handle(h.frame({
      cmdId: "c-missing",
      cmd: { kind: "t3.start", args: { projectId: "p1", title: "标题", dispatchId: "d-x" } },
    }));
    expect(unknown).toEqual({ ok: false, error: "不支持的指令：t3.nope" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.startsWith("参数不对")).toBe(true);
    expect(h.t3.launches).toHaveLength(0);
  });

  test("第一次 tick 只建基线，状态变化才发事件，账本外会话不发", async () => {
    const h = track(await make());
    const started = await h.executor.handle(h.frame({ cmd: startCmd("d-1") }));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const threadId = (started.result as { threadId: string }).threadId;
    h.t3.outside = {
      threadId: "outside",
      title: "别的",
      status: "running",
      latestRunId: null,
      snoozed: false,
      link: null,
    };
    await h.executor.tick();
    expect(h.events).toHaveLength(0);
    const row = h.t3.threads.get(threadId);
    if (!row) throw new Error("missing thread");
    row.status = "completed";
    if (h.t3.outside) h.t3.outside = { ...h.t3.outside, status: "failed" };
    await h.executor.tick();
    expect(h.events).toEqual([{
      to: SENDER_ID,
      frame: {
        dispatchId: "d-1",
        kind: "thread.status",
        data: {
          threadId,
          status: "completed",
          previous: "running",
          title: "标题",
          link: `https://t3.example/${threadId}`,
        },
      },
    }]);
  });

  test("短任务在第一次轮询前就做完，也会发出状态变化（以 running 为起点）", async () => {
    const h = track(await make());
    const started = await h.executor.handle(h.frame({ cmd: startCmd("d-fast") }));
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const threadId = (started.result as { threadId: string }).threadId;
    const row = h.t3.threads.get(threadId);
    if (!row) throw new Error("missing thread");
    row.status = "completed";
    await h.executor.tick();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.frame).toMatchObject({
      dispatchId: "d-fast",
      kind: "thread.status",
      data: { threadId, status: "completed", previous: "running" },
    });
    await h.executor.tick();
    expect(h.events).toHaveLength(1);
  });

  test("hello 只返回白名单里且 T3 存在的项目，T3 出错时 ready 为 false", async () => {
    const h = track(await make());
    expect(await h.executor.hello()).toEqual({
      enabled: true,
      t3: { ready: true },
      projects: [{ id: "p1", name: "you-brain" }],
      maxMode: "auto",
    });
    const listed = await h.executor.handle(h.frame({ cmdId: "c-projects", cmd: { kind: "t3.projects", args: {} } }));
    expect(listed).toEqual({ ok: true, result: { projects: [{ id: "p1", name: "you-brain" }] } });

    await h.executor.updatePolicy({ maxMode: "full-access", allowedProjects: ["p2"] });
    expect(await h.executor.hello()).toMatchObject({
      enabled: true,
      maxMode: "full-access",
      projects: [{ id: "p2", name: "other" }],
    });

    h.t3.throwProjects = true;
    const down = await h.executor.hello();
    expect(down.t3).toEqual({ ready: false });
    expect(down.projects).toEqual([]);
    expect(down.enabled).toBe(true);
  });

  test("策略文件是 0600，损坏后回落默认，审计里没有 prompt", async () => {
    const h = track(await make());
    await h.executor.handle(h.frame({
      cmd: { kind: "t3.start", args: { projectId: "p1", title: "标题", prompt: PROMPT, dispatchId: "d-secret" } },
    }));
    const audit = await readFile(join(h.dir, "dispatch", "audit.jsonl"), "utf8");
    expect(audit).not.toContain(PROMPT);
    const policyFile = join(h.dir, "dispatch", "policy.json");
    expect((await stat(policyFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(h.dir, "dispatch", "ledger.json"))).mode & 0o777).toBe(0o600);

    await writeFile(policyFile, "{", "utf8");
    expect(await h.executor.policy()).toEqual(defaultDispatchPolicy());
  });

  test("创建失败不写入派活账本，并带回 T3 的错误说明", async () => {
    const h = track(await make());
    h.t3.failLaunch = true;
    const failed = await h.executor.handle(h.frame({ cmdId: "c-fail", cmd: startCmd("d-fail") }));
    expect(failed).toEqual({ ok: false, error: "无法连接 T3" });
    const again = await h.executor.handle(h.frame({ cmdId: "c-fail", cmd: startCmd("d-fail") }));
    expect(again).toEqual(failed);
    expect(h.t3.launches).toHaveLength(1);
    expect(h.notifies).toHaveLength(0);
    const ledger = JSON.parse(await readFile(join(h.dir, "dispatch", "ledger.json"), "utf8")) as {
      dispatches: Record<string, unknown>;
    };
    expect(ledger.dispatches["d-fail"]).toBeUndefined();
  });

  test("notify 关闭或没有回调时不通知", async () => {
    const quiet = track(await make({ notify: false }));
    await quiet.executor.handle(quiet.frame());
    expect(quiet.t3.launches).toHaveLength(1);
    expect(quiet.notifies).toHaveLength(0);

    const noCallback = track(await make({ withNotify: false }));
    await noCallback.executor.handle(noCallback.frame());
    expect(noCallback.notifies).toHaveLength(0);
  });
});

function startCmd(dispatchId: string): CommandSigningFields["cmd"] {
  return { kind: "t3.start", args: { projectId: "p1", title: "标题", prompt: "做这件事", dispatchId } };
}
