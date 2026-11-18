import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TaskService } from "../../src/tasks/service.js";
import { TaskStore } from "../../src/tasks/store.js";
import type { TaskAutomationPort, TaskGitPort } from "../../src/tasks/types.js";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); }
  finally { await f.service.stop(); await rm(f.dir, { recursive: true, force: true }); }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "yb-todo-service-"));
  let counter = 0;
  const starts: Array<Parameters<TaskAutomationPort["start"]>[0]> = [];
  const followups: Array<{ threadId: string; prompt: string; commandId: string }> = [];
  const merges: string[] = [];
  const states = new Map<string, "running" | "ready" | "failed">();
  let startFailure = false;
  let followupFailure = false;
  let online = true;
  let projectCwd = "/repo/one";
  let failDoneWrite = false;
  const created: Array<{ id: string; name: string; cwd: string }> = [];
  const store = new TaskStore(join(dir, "tasks", "board.json"));
  const automation: TaskAutomationPort = {
    async projects() {
      if (!online) throw new Error("T3 offline");
      return [{ id: "one", name: "One", cwd: projectCwd }, { id: "two", name: "Two", cwd: "/repo/two" }, ...created];
    },
    async createProject(input) {
      const project = { id: `new-${created.length + 1}`, name: input.name, cwd: input.cwd ?? `/t3/${input.name}` };
      created.push(project);
      return project;
    },
    async start(input) {
      starts.push(input);
      if (startFailure) throw new Error("dispatch uncertain");
      const threadId = `thread-${input.requestId}`;
      states.set(threadId, "running");
      return { threadId, threadUrl: `http://127.0.0.1:3773/env/${threadId}` };
    },
    async inspect(threadId) { return { state: states.get(threadId) ?? "running", summary: "验证结果" }; },
    async followup(threadId, prompt, commandId) {
      followups.push({ threadId, prompt, commandId });
      if (followupFailure) throw new Error("feedback uncertain");
      states.set(threadId, "running");
    },
  };
  const git: TaskGitPort = {
    async prepare(_project, taskId) { return { branch: `task/${taskId}`, worktreePath: `/tasks/${taskId}`, baseSha: BASE }; },
    async review() { return { headSha: SHA, baseSha: BASE, stat: "1 file", diff: "+change", truncated: false }; },
    async merge(_project, taskRun, approvedSha) {
      expect(taskRun.reviewSha).toBe(approvedSha);
      merges.push(approvedSha);
    },
  };
  const options = {
    dataDir: dir, automation, git,
    id: () => `task-${++counter}`,
    now: () => new Date("2026-11-16T00:00:00Z"),
    store: {
      read: () => store.read(),
      async write(state: Parameters<TaskStore["write"]>[0]) {
        if (failDoneWrite && state.tasks.some((task) => task.status === "done")) {
          failDoneWrite = false;
          throw new Error("fixture disk failure");
        }
        await store.write(state);
      },
    },
  };
  const service = new TaskService(options);
  const board = () => service.board();
  const ready = async () => {
    const current = (await board()).tasks.find((task) => task.status === "running")!;
    states.set(current.run!.threadId!, "ready");
    await service.tick();
    return (await board()).tasks.find((task) => task.id === current.id)!;
  };
  return {
    dir, service, starts, merges, states, followups, board, ready, options, created,
    setStartFailure(value: boolean) { startFailure = value; },
    setFollowupFailure(value: boolean) { followupFailure = value; },
    setOnline(value: boolean) { online = value; },
    setProjectCwd(value: string) { projectCwd = value; },
    failNextDoneWrite() { failDoneWrite = true; },
  };
}

async function enable(service: TaskService, projectId = "one") {
  await service.action({ action: "project", projectId, enabled: true });
  await service.tick();
}

describe("T3 TODO serial queue", () => {
  test("P0 first, FIFO tie, unassigned TODO never starts", () => fixture(async (f) => {
    await f.service.create({ title: "unassigned", priority: 0 });
    await f.service.create({ title: "low", projectId: "one", priority: 3 });
    await f.service.create({ title: "first high", projectId: "one", priority: 0 });
    await f.service.create({ title: "second high", projectId: "one", priority: 0 });
    expect(f.starts).toHaveLength(0);
    await enable(f.service);
    expect(f.starts.map((item) => item.title)).toEqual(["first high"]);
    await f.service.tick();
    expect(f.starts).toHaveLength(1);
    expect((await f.board()).tasks[0]?.status).toBe("queued");
  }));

  test("a TODO can register a new T3 project; a folder already in T3 is reused instead", () => fixture(async (f) => {
    let board = await f.service.create({ title: "new repo", newProject: { name: "Fresh" } });
    expect(f.created).toEqual([{ id: "new-1", name: "Fresh", cwd: "/t3/Fresh" }]);
    expect(board.tasks[0]?.projectId).toBe("new-1");
    expect(board.projects.find((item) => item.id === "new-1")?.enabled).toBe(false);
    board = await f.service.create({ title: "existing folder", newProject: { name: "whatever", cwd: "/repo/two/" } });
    expect(f.created).toHaveLength(1);
    expect(board.tasks[1]?.projectId).toBe("two");
    board = await f.service.update({ id: board.tasks[1]!.id, newProject: { name: "Legal", cwd: "/repo/legal" } });
    expect(board.tasks[1]?.projectId).toBe("new-2");
    await expect(f.service.create({ title: "both", projectId: "one", newProject: { name: "X" } })).rejects.toThrow("二选一");
    f.setOnline(false);
    await expect(f.service.create({ title: "offline", newProject: { name: "Y" } })).rejects.toThrow("T3 offline");
    expect(f.created).toHaveLength(2);
  }));

  test("same-millisecond tasks retain arrival order even when UUID order differs", () => fixture(async (f) => {
    f.options.id = () => "z-first";
    await f.service.create({ title: "first", projectId: "one" });
    f.options.id = () => "a-second";
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    expect(f.starts[0]?.title).toBe("first");
  }));

  test("completed turn waits for exact manual approval, then next TODO starts", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    const review = await f.ready();
    expect(review.status).toBe("review");
    await f.service.tick();
    expect(f.merges).toHaveLength(0);
    expect(f.starts).toHaveLength(1);
    await expect(f.service.action({ action: "approve", id: review.id, reviewSha: BASE })).rejects.toThrow("核对版本已变化");
    expect(f.merges).toHaveLength(0);
    const detail = await f.service.review(review.id);
    await f.service.action({ action: "approve", id: review.id, reviewSha: detail.headSha });
    await f.service.tick();
    expect(f.merges).toEqual([SHA]);
    expect(f.starts.map((item) => item.title)).toEqual(["first", "second"]);
  }));

  test("pause lets current task finish but prevents next claim", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    await f.service.action({ action: "project", projectId: "one", enabled: false });
    const task = await f.ready();
    await f.service.action({ action: "approve", id: task.id, reviewSha: SHA });
    await f.service.tick();
    expect(f.merges).toHaveLength(1);
    expect(f.starts).toHaveLength(1);
  }));

  test("concurrent ticks never claim a second task in the same project", () => fixture(async (f) => {
    await f.service.create({ title: "one", projectId: "one" });
    await f.service.create({ title: "two", projectId: "one" });
    await Promise.all([enable(f.service), f.service.tick(), f.service.tick()]);
    expect(f.starts).toHaveLength(1);
    await expect(f.service.update({ id: f.starts[0]!.requestId, title: "changed" })).rejects.toThrow();
    const task = (await f.board()).tasks.find((item) => item.status === "running")!;
    await expect(f.service.update({ id: task.id, title: "changed" })).rejects.toThrow("只有待处理");
  }));

  test("different projects can advance independently", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "other", projectId: "two" });
    await enable(f.service);
    await enable(f.service, "two");
    expect(f.starts).toHaveLength(2);
  }));

  test("rejection reuses original thread and uncertain followup retries with same command ID", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    const task = await f.ready();
    f.setFollowupFailure(true);
    await expect(f.service.action({ action: "reject", id: task.id, feedback: "补上校验" })).rejects.toThrow("feedback uncertain");
    expect((await f.board()).tasks[0]?.status).toBe("failed");
    expect(f.merges).toHaveLength(0);
    f.setFollowupFailure(false);
    await f.service.action({ action: "retry", id: task.id });
    await f.service.tick();
    expect(f.followups).toHaveLength(2);
    expect(f.followups[0]?.commandId).toBe(f.followups[1]?.commandId);
    expect(f.followups[1]?.threadId).toBe(task.run!.threadId!);
    expect(f.starts).toHaveLength(1);
    expect((await f.board()).tasks[0]?.status).toBe("running");
  }));

  test("failed turn blocks project and explicit retry continues same T3 thread", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    const first = (await f.board()).tasks[0]!;
    f.states.set(first.run!.threadId!, "failed");
    await f.service.tick();
    expect((await f.board()).tasks[0]?.status).toBe("failed");
    await f.service.tick();
    expect(f.starts).toHaveLength(1);
    await f.service.action({ action: "retry", id: first.id });
    await f.service.tick();
    expect(f.followups).toHaveLength(1);
    expect(f.followups[0]?.threadId).toBe(first.run!.threadId!);
    expect(f.starts).toHaveLength(1);
  }));

  test("uncertain initial dispatch persists and retries same thread", () => fixture(async (f) => {
    f.setStartFailure(true);
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    const task = (await f.board()).tasks[0]!;
    expect(task.status).toBe("failed");
    expect(task.run?.requestId).toBe(f.starts[0]?.requestId);
    expect(task.run?.threadId).toBeNull();
    f.setStartFailure(false);
    await f.service.action({ action: "retry", id: task.id });
    await f.service.tick();
    expect(f.starts).toHaveLength(2);
    expect(f.starts[0]?.requestId).toBe(f.starts[1]?.requestId);
    expect((await f.board()).tasks[0]?.run?.threadId).toBe(`thread-${f.starts[0]?.requestId}`);
  }));

  test("daemon restart resumes monitoring without duplicate dispatch", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    await f.service.stop();
    const resumed = new TaskService(f.options);
    try {
      await resumed.tick();
      expect(f.starts).toHaveLength(1);
      f.states.set(`thread-${f.starts[0]!.requestId}`, "ready");
      await resumed.tick();
      expect((await resumed.board()).tasks[0]?.status).toBe("review");
      expect(f.merges).toHaveLength(0);
    } finally { await resumed.stop(); }
  }));

  test("T3 offline preserves queue and performs no repository operation", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    f.setOnline(false);
    await f.service.tick();
    const board = await f.board();
    expect(board.connectionError).toBe("T3 offline");
    expect(board.tasks[0]?.status).toBe("queued");
    expect(f.starts).toHaveLength(0);
  }));

  test("pausing offline persists locally and prevents a later claim", () => fixture(async (f) => {
    await enable(f.service);
    f.setOnline(false);
    await f.service.action({ action: "project", projectId: "one", enabled: false });
    f.setOnline(true);
    await f.service.create({ title: "must stay queued", projectId: "one" });
    await f.service.tick();
    expect(f.starts).toHaveLength(0);
    expect((await f.board()).projects[0]?.enabled).toBe(false);
  }));

  test("a changed T3 project directory disables automatic claiming", () => fixture(async (f) => {
    await enable(f.service);
    f.setProjectCwd("/repo/another");
    await f.service.create({ title: "must not start in another repository", projectId: "one" });
    await f.service.tick();
    expect(f.starts).toHaveLength(0);
    expect((await f.board()).projects[0]?.enabled).toBe(false);
  }));

  test("a successful merge with a failed done write recovers the approved merging state", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    const task = await f.ready();
    f.failNextDoneWrite();
    await expect(f.service.action({ action: "approve", id: task.id, reviewSha: SHA })).rejects.toThrow("状态保存失败");
    expect(f.merges).toHaveLength(1);
    expect((await f.board()).tasks[0]?.status).toBe("merging");
    expect((await f.board()).tasks[0]?.run?.reviewSha).toBe(SHA);
    await f.service.tick();
    expect((await f.board()).tasks[0]?.status).toBe("done");
    expect(f.merges).toEqual([SHA, SHA]);
    expect(f.starts).toHaveLength(1);
  }));

  test("shutdown refuses late approvals before they can reach T3 or Git", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    const task = await f.ready();
    await f.service.stop();
    await expect(f.service.action({ action: "approve", id: task.id, reviewSha: SHA })).rejects.toThrow("正在退出");
    expect(f.merges).toHaveLength(0);
  }));

  test("corrupt queue file fails closed and is not replaced", () => fixture(async (f) => {
    await f.service.stop();
    await writeFile(join(f.dir, "tasks", "board.json"), "invalid json").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(f.dir, "tasks"), { recursive: true });
      await writeFile(join(f.dir, "tasks", "board.json"), "invalid json");
    });
    const resumed = new TaskService(f.options);
    try {
      await expect(resumed.board()).rejects.toThrow();
      expect(await readFile(join(f.dir, "tasks", "board.json"), "utf8")).toBe("invalid json");
    } finally { await resumed.stop(); }
  }));
});
