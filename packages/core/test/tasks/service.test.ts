import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { TaskAlreadyMergedError, TaskBehindDevelopError, TaskDirtyWorktreeError, TaskMergeBlockedError, TaskNoCommitError } from "../../src/tasks/git.js";
import { PROJECT_PARALLEL_LIMIT, TaskService } from "../../src/tasks/service.js";
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
  const syncs: string[] = [];
  const publishes: string[] = [];
  const cleanups: string[] = [];
  const states = new Map<string, "planning" | "running" | "ready" | "failed">();
  let startFailure = false;
  let followupFailure = false;
  let online = true;
  let projectCwd = "/repo/one";
  let failRemovalWrite = false;
  let savedCount = 0;
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
      states.set(threadId, input.plan ? "planning" : "running");
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
    async isMerged() { return false; },
    async review() { return { headSha: SHA, baseSha: BASE, stat: "1 file", diff: "+change", truncated: false }; },
    async merge(_project, taskRun, approvedSha) {
      expect(taskRun.reviewSha).toBe(approvedSha);
      merges.push(approvedSha);
    },
    async syncDevelop() { syncs.push("merged"); return "merged"; },
    async publish(_project, run) { publishes.push(run.branch); return "pushed"; },
    async cleanup(_project, run) { cleanups.push(run.branch); },
  };
  const options = {
    dataDir: dir, automation, git, homeDir: "/Users/hong",
    id: () => `task-${++counter}`,
    now: () => new Date("2026-11-16T00:00:00Z"),
    store: {
      read: () => store.read(),
      async write(state: Parameters<TaskStore["write"]>[0]) {
        if (failRemovalWrite && state.tasks.length < savedCount) {
          failRemovalWrite = false;
          throw new Error("fixture disk failure");
        }
        await store.write(state);
        savedCount = state.tasks.length;
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
    dir, service, starts, merges, syncs, publishes, cleanups, states, followups, board, ready, options, created,
    setStartFailure(value: boolean) { startFailure = value; },
    setFollowupFailure(value: boolean) { followupFailure = value; },
    setOnline(value: boolean) { online = value; },
    setProjectCwd(value: string) { projectCwd = value; },
    failNextRemovalWrite() { failRemovalWrite = true; },
  };
}

async function enable(service: TaskService, projectId = "one") {
  await service.action({ action: "project", projectId, enabled: true });
  await service.tick();
}

describe("T3 TODO parallel queue", () => {
  test("P0 first, FIFO tie, unassigned TODO never starts", () => fixture(async (f) => {
    await f.service.create({ title: "unassigned", priority: 0 });
    await f.service.create({ title: "low", projectId: "one", priority: 3 });
    await f.service.create({ title: "first high", projectId: "one", priority: 0 });
    await f.service.create({ title: "second high", projectId: "one", priority: 0 });
    await f.service.create({ title: "middle", projectId: "one", priority: 2 });
    expect(f.starts).toHaveLength(0);
    expect(PROJECT_PARALLEL_LIMIT).toBe(3);
    await enable(f.service);
    expect(f.starts.map((item) => item.title)).toEqual(["first high", "second high", "middle"]);
    await f.service.tick();
    expect(f.starts).toHaveLength(3);
    expect((await f.board()).tasks.map((task) => task.status)).toEqual(["queued", "queued", "running", "running", "running"]);
  }));

  test("manual start picks the clicked TODO in a paused project; planning occupies a parallel slot", () => fixture(async (f) => {
    const first = (await f.service.create({ title: "automatic priority", projectId: "one", priority: 0 })).tasks[0]!;
    const selected = (await f.service.create({ title: "user selected", description: "验收说明", projectId: "one", priority: 3 })).tasks[1]!;
    const started = await f.service.action({ action: "start", id: selected.id });
    expect(started.projects.find((item) => item.id === "one")?.enabled).toBe(false);
    expect(started.tasks[1]).toMatchObject({ status: "planning", run: { worktreePath: `/tasks/${selected.id}`, threadUrl: expect.stringContaining("http://127.0.0.1") } });
    expect(f.starts[0]).toMatchObject({ projectId: "one", title: selected.title, cwd: `/tasks/${selected.id}`, plan: true });
    expect(f.starts[0]?.prompt).toContain("验收说明");
    expect(f.starts[0]?.prompt).toContain("明确确认需求和计划");
    await expect(f.service.action({ action: "start", id: selected.id })).rejects.toThrow("只有待处理");
    await enable(f.service);
    expect(f.starts.map((item) => item.title)).toEqual(["user selected", "automatic priority"]);
    expect((await f.board()).tasks.map((task) => task.status)).toEqual(["running", "planning"]);
  }));

  test("unassigned manual start persists its home directory and never uses Git", () => fixture(async (f) => {
    f.options.git.prepare = async () => { throw new Error("unexpected git prepare"); };
    f.options.git.review = async () => { throw new Error("unexpected git review"); };
    const queued = (await f.service.create({ title: "文档梳理" })).tasks[0]!;
    f.setStartFailure(true);
    const failed = (await f.service.action({ action: "start", id: queued.id })).tasks[0]!;
    expect(failed.status).toBe("failed");
    const first = f.starts[0]!;
    expect(first).toMatchObject({ projectId: null, branch: null, cwd: "/Users/hong", plan: true });
    f.setStartFailure(false);
    await f.service.action({ action: "retry", id: queued.id });
    await f.service.tick();
    expect(f.starts[1]?.requestId).toBe(first.requestId);
    const planning = (await f.board()).tasks[0]!;
    expect(planning).toMatchObject({ projectId: null, status: "planning", run: { branch: null, worktreePath: null, projectCwd: "/Users/hong" } });
    await expect(f.service.action({ action: "approve", id: queued.id, reviewSha: SHA })).rejects.toThrow("不参与代码核对和合并");
    f.states.set(planning.run!.threadId!, "ready");
    await f.service.tick();
    expect((await f.board()).tasks[0]).toMatchObject({ status: "done", run: { summary: "验证结果", reviewSha: null } });
    expect(f.merges).toHaveLength(0);
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

  test("manual completion persists offline without touching Git or the task session", () => fixture(async (f) => {
    const task = (await f.service.create({ title: "manual completion", projectId: "one" })).tasks[0]!;
    const started = (await f.service.action({ action: "start", id: task.id })).tasks[0]!;
    f.states.set(started.run!.threadId!, "failed");
    await f.service.tick();
    const failed = (await f.board()).tasks[0]!;
    expect(failed.status).toBe("failed");
    let externalCalls = 0;
    const unavailable = async (): Promise<never> => { externalCalls += 1; throw new Error("offline"); };
    f.options.automation.projects = unavailable;
    f.options.automation.inspect = unavailable;
    f.options.git.isMerged = unavailable;
    f.options.git.review = unavailable;
    f.options.git.merge = unavailable;
    const completed = (await f.service.action({ action: "complete", id: task.id })).tasks[0]!;
    expect(completed).toMatchObject({ status: "done", completedManually: true, error: null });
    expect(completed.run).toEqual({ ...failed.run!, error: null });
    expect((await f.options.store.read()).tasks[0]).toEqual(completed);
    expect(externalCalls).toBe(0);
    expect(f.starts).toHaveLength(1);
    expect(f.followups).toHaveLength(0);
  }));

  test("completed turn waits for exact manual approval, then next TODO starts", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    const review = await f.ready();
    expect(review.status).toBe("review");
    await f.service.tick();
    expect(f.merges).toHaveLength(0);
    expect(f.starts).toHaveLength(2);
    await expect(f.service.action({ action: "approve", id: review.id, reviewSha: BASE })).rejects.toThrow("核对版本已变化");
    expect(f.merges).toHaveLength(0);
    const detail = await f.service.review(review.id);
    const approved = await f.service.action({ action: "approve", id: review.id, reviewSha: detail.headSha });
    // 合并后推送 develop、删除任务分支和工作树，并从列表移除这个 TODO。
    expect(approved.tasks.map((item) => item.title)).toEqual(["second"]);
    expect(f.publishes).toEqual([`task/${review.id}`]);
    expect(f.cleanups).toEqual([`task/${review.id}`]);
    await expect(f.service.action({ action: "complete", id: review.id })).rejects.toThrow("TODO 不存在");
    await f.service.tick();
    expect(f.merges).toEqual([SHA]);
    expect(f.starts.map((item) => item.title)).toEqual(["first", "second"]);
  }));

  test("refreshes the old worktree error and clears the counts when T3 resumes", () => fixture(async (f) => {
    const legacyError = "任务工作树有未提交或未跟踪的内容，请在 T3 中提交后重新检查";
    const counts = { uncommitted: 0, untracked: 1 };
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    f.options.git.review = async () => { throw new Error(legacyError); };
    const task = await f.ready();
    expect(task).toMatchObject({ status: "failed", error: legacyError });
    expect(task.worktreeBlock).toBeUndefined();

    f.options.git.review = async () => { throw new TaskDirtyWorktreeError(counts); };
    await f.service.tick();
    expect((await f.options.store.read()).tasks[0]).toMatchObject({ status: "failed", worktreeBlock: counts });
    expect(f.starts).toHaveLength(2);

    f.states.set(task.run!.threadId!, "running");
    await f.service.tick();
    const running = (await f.board()).tasks[0]!;
    expect(running).toMatchObject({ status: "running", error: null, run: { error: null } });
    expect(running.worktreeBlock).toBeUndefined();
  }));

  test("a merge blocked by develop history leaves the task reviewable until it is fixed and reapproved", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    const task = await f.ready();
    const merge = f.options.git.merge;
    const mergeError = "本地 develop 已退回到任务起点之前";
    f.options.git.merge = async () => { throw new TaskMergeBlockedError(mergeError); };
    const detail = await f.service.review(task.id);
    await expect(f.service.action({ action: "approve", id: task.id, reviewSha: detail.headSha })).rejects.toThrow(mergeError);
    await f.service.tick();
    expect((await f.board()).tasks[0]).toMatchObject({ status: "review", error: mergeError });
    expect((await f.service.review(task.id)).diff).toBe(detail.diff);
    expect(f.starts).toHaveLength(2);
    expect(f.merges).toHaveLength(0);
    expect(f.syncs).toHaveLength(0);

    const synced = "c".repeat(40);
    f.options.git.review = async () => ({ headSha: synced, baseSha: BASE, stat: "1 file", diff: "+change", truncated: false });
    f.options.git.merge = merge;
    expect((await f.service.review(task.id)).task).toMatchObject({ status: "review", error: null, run: { error: null } });
    await expect(f.service.action({ action: "approve", id: task.id, reviewSha: detail.headSha })).rejects.toThrow("核对版本已变化");
    await f.service.action({ action: "approve", id: task.id, reviewSha: synced });
    expect(f.merges).toEqual([synced]);
  }));

  test("rechecking a previously blocked review uses the same T3 turn", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    const review = f.options.git.review;
    f.options.git.review = async () => { throw new Error("develop 已发生分歧，请先在 T3 中处理后重新核对"); };
    const blocked = await f.ready();
    expect(blocked.status).toBe("failed");
    f.options.git.review = review;
    await f.service.action({ action: "retry", id: blocked.id });
    await f.service.tick();
    expect((await f.service.review(blocked.id)).task).toMatchObject({ status: "review", error: null, run: { threadId: blocked.run?.threadId } });
    expect(f.starts).toHaveLength(1);
    expect(f.followups).toHaveLength(0);
    expect(f.merges).toHaveLength(0);
  }));

  test("recovers a saved false failure when the task is already merged outside the board", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    const task = await f.ready();
    f.options.git.review = async () => { throw new TaskNoCommitError(); };
    await expect(f.service.review(task.id)).rejects.toThrow("没有可核对的提交");
    expect((await f.board()).tasks[0]?.status).toBe("failed");
    await f.service.stop();

    f.options.git.isMerged = async (_project, run) => run.branch === task.run?.branch;
    const resumed = new TaskService(f.options);
    try {
      await resumed.tick();
      expect((await resumed.board()).tasks.map((item) => item.title)).toEqual(["second"]);
      expect(f.publishes).toEqual([`task/${task.id}`]);
      expect(f.cleanups).toEqual([`task/${task.id}`]);
      expect(f.merges).toHaveLength(0);
      expect(f.followups).toHaveLength(0);
      await resumed.tick();
      expect(f.starts.map((item) => item.title)).toEqual(["first", "second"]);
    } finally { await resumed.stop(); }
  }));

  test.each(["completed turn", "opened review"])("records an external merge found on %s", (stage) => fixture(async (f) => {
    const task = (await f.service.create({ title: "task", projectId: "one" })).tasks[0]!;
    await enable(f.service);
    if (stage === "opened review") await f.ready();
    f.options.git.review = async () => { throw new TaskAlreadyMergedError(); };

    if (stage === "opened review") {
      await expect(f.service.review(task.id)).rejects.toThrow("任务提交已合入本地 develop");
    } else {
      await f.ready();
    }
    // 外部合并同样推送 develop、清理分支并移除任务；本身不再合并。
    expect((await f.board()).tasks).toEqual([]);
    expect(f.publishes).toEqual([`task/${task.id}`]);
    expect(f.cleanups).toEqual([`task/${task.id}`]);
    expect(f.merges).toHaveLength(0);
  }));

  test("pause lets current task finish but prevents next claim", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await enable(f.service);
    await f.service.action({ action: "project", projectId: "one", enabled: false });
    await f.service.create({ title: "second", projectId: "one" });
    const task = await f.ready();
    await f.service.action({ action: "approve", id: task.id, reviewSha: SHA });
    await f.service.tick();
    expect(f.merges).toHaveLength(1);
    expect(f.starts).toHaveLength(1);
  }));

  test("concurrent ticks never claim a task twice or exceed the parallel limit", () => fixture(async (f) => {
    for (const title of ["one", "two", "three", "four"]) await f.service.create({ title, projectId: "one" });
    await Promise.all([enable(f.service), f.service.tick(), f.service.tick()]);
    expect(f.starts.map((item) => item.title)).toEqual(["one", "two", "three"]);
    expect(new Set(f.starts.map((item) => item.requestId)).size).toBe(3);
    expect((await f.board()).tasks[3]?.status).toBe("queued");
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

  test("a failed turn frees its slot and explicit retry continues the same T3 thread", () => fixture(async (f) => {
    for (const title of ["first", "second", "third", "fourth"]) await f.service.create({ title, projectId: "one" });
    await enable(f.service);
    expect(f.starts).toHaveLength(3);
    const first = (await f.board()).tasks[0]!;
    f.states.set(first.run!.threadId!, "failed");
    await f.service.tick();
    expect((await f.board()).tasks[0]?.status).toBe("failed");
    expect(f.starts.map((item) => item.title)).toEqual(["first", "second", "third", "fourth"]);
    await f.service.action({ action: "retry", id: first.id });
    await f.service.tick();
    expect(f.followups).toHaveLength(1);
    expect(f.followups[0]?.threadId).toBe(first.run!.threadId!);
    expect(f.starts).toHaveLength(4);
    await expect(f.service.create({ title: "fifth", projectId: "one" })).resolves.toBeDefined();
    await f.service.tick();
    expect(f.starts).toHaveLength(4);
  }));

  test("a dispatch that fails before T3 accepts it keeps its slot instead of failing the whole queue", () => fixture(async (f) => {
    for (const title of ["first", "second", "third", "fourth", "fifth"]) await f.service.create({ title, projectId: "one" });
    f.setStartFailure(true);
    await enable(f.service);
    await f.service.tick();
    await f.service.tick();
    await f.service.tick();
    expect(f.starts.map((item) => item.title)).toEqual(["first", "second", "third"]);
    expect((await f.board()).tasks.map((task) => task.status)).toEqual(["failed", "failed", "failed", "queued", "queued"]);
    await expect(f.service.action({ action: "start", id: (await f.board()).tasks[3]!.id })).rejects.toThrow("项目已有 3 个");
  }));

  test("approving a task whose branch is behind develop syncs develop in, then merges, pushes and removes it", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    const merge = f.options.git.merge;
    f.options.git.merge = async (...args) => {
      if (f.syncs.length === 0) throw new TaskBehindDevelopError("任务分支尚未包含最新的 develop");
      return merge(...args);
    };
    const task = await f.ready();
    const synced = "c".repeat(40);
    f.options.git.review = async () => ({ headSha: synced, baseSha: SHA, stat: "1 file", diff: "+change", truncated: false });
    const board = await f.service.action({ action: "approve", id: task.id, reviewSha: SHA });
    // 同步 develop 后以合并提交为准继续快进，不再回 T3、不再要求重新核对。
    expect(f.syncs).toEqual(["merged"]);
    expect(f.followups).toHaveLength(0);
    expect(f.merges).toEqual([synced]);
    expect(f.publishes).toEqual([`task/${task.id}`]);
    expect(f.cleanups).toEqual([`task/${task.id}`]);
    expect(board.tasks.map((item) => item.title)).toEqual(["second"]);
  }));

  test("a push failure keeps the merged task for manual handling; retry only pushes again", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    const task = await f.ready();
    let pushFails = true;
    f.options.git.publish = async (_project, run) => {
      f.publishes.push(run.branch);
      if (pushFails) throw new Error("已合并到本地 develop，但推送到 origin 失败：non-fast-forward。请人工处理后点“重试”");
      return "pushed";
    };
    await expect(f.service.action({ action: "approve", id: task.id, reviewSha: SHA })).rejects.toThrow("推送到 origin 失败");
    expect((await f.board()).tasks[0]).toMatchObject({ status: "failed", run: { merged: true } });
    expect(f.merges).toEqual([SHA]);
    expect(f.cleanups).toHaveLength(0);
    // 轮询不会自动反复推送。
    await f.service.tick();
    await f.service.tick();
    expect(f.publishes).toHaveLength(1);
    expect((await f.board()).tasks[0]?.status).toBe("failed");

    pushFails = false;
    const board = await f.service.action({ action: "retry", id: task.id });
    expect(board.tasks).toEqual([]);
    expect(f.publishes).toHaveLength(2);
    expect(f.cleanups).toEqual([`task/${task.id}`]);
    expect(f.merges).toEqual([SHA]);
  }));

  test("a conflicting develop sync is undone and T3 is asked to merge and resolve it", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    f.options.git.merge = async () => { throw new TaskBehindDevelopError("任务分支尚未包含最新的 develop"); };
    f.options.git.syncDevelop = async () => "conflict";
    const task = await f.ready();
    f.setFollowupFailure(true);
    await expect(f.service.action({ action: "approve", id: task.id, reviewSha: SHA })).rejects.toThrow("feedback uncertain");
    expect((await f.board()).tasks[0]).toMatchObject({ status: "failed", run: { reviewSha: null } });
    f.setFollowupFailure(false);
    await f.service.action({ action: "retry", id: task.id });
    await f.service.tick();
    expect(f.followups).toHaveLength(2);
    expect(f.followups[0]?.commandId).toBe(f.followups[1]?.commandId);
    expect(f.followups[1]?.prompt).toContain("git merge develop");
    expect(f.followups[1]?.prompt).toContain("不要 rebase");
    expect((await f.board()).tasks[0]?.status).toBe("running");
    expect(f.merges).toHaveLength(0);
  }));

  test("develop moving again during sync keeps the task reviewable", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    f.options.git.merge = async () => { throw new TaskBehindDevelopError("任务分支尚未包含最新的 develop"); };
    f.options.git.syncDevelop = async () => "current";
    const task = await f.ready();
    await expect(f.service.action({ action: "approve", id: task.id, reviewSha: SHA })).rejects.toThrow("刚刚发生变化");
    expect((await f.board()).tasks[0]).toMatchObject({ status: "review" });
    expect(f.followups).toHaveLength(0);
  }));

  test("turn ends without a commit: waits as requirement confirmation instead of failing", () => fixture(async (f) => {
    await f.service.create({ title: "ask first", projectId: "one" });
    await enable(f.service);
    const task = (await f.board()).tasks[0]!;
    const review = f.options.git.review;
    f.options.git.review = async () => { throw new TaskNoCommitError(); };
    f.states.set(task.run!.threadId!, "ready");
    await f.service.tick();
    expect((await f.board()).tasks[0]).toMatchObject({ status: "planning" });
    f.options.git.review = review;
    await f.service.tick();
    expect((await f.board()).tasks[0]?.status).toBe("review");
  }));

  test("a failed TODO returns to work by itself once its T3 thread runs again", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    const first = (await f.board()).tasks[0]!;
    f.options.git.review = async () => { throw new Error("develop 已发生分歧"); };
    f.states.set(first.run!.threadId!, "ready");
    await f.service.tick();
    expect((await f.board()).tasks[0]?.status).toBe("failed");
    await f.service.tick();
    expect((await f.board()).tasks[0]?.status).toBe("failed");
    f.states.set(first.run!.threadId!, "running");
    await f.service.tick();
    expect((await f.board()).tasks[0]).toMatchObject({ status: "running", error: null });
    expect(f.starts).toHaveLength(2);
    expect(f.followups).toHaveLength(0);
  }));

  test("a TODO waiting for review goes back to work when the user continues in T3", () => fixture(async (f) => {
    await f.service.create({ title: "first", projectId: "one" });
    await f.service.create({ title: "second", projectId: "one" });
    await enable(f.service);
    const reviewed = await f.ready();
    expect(reviewed).toMatchObject({ status: "review", run: { reviewSha: SHA } });
    await f.service.tick();
    expect((await f.board()).tasks[0]?.status).toBe("review");
    f.states.set(reviewed.run!.threadId!, "running");
    await f.service.tick();
    expect((await f.board()).tasks[0]).toMatchObject({ status: "running", run: { reviewSha: null } });
    expect(f.starts).toHaveLength(2);
    await expect(f.service.action({ action: "approve", id: reviewed.id, reviewSha: SHA })).rejects.toThrow();
    f.states.set(reviewed.run!.threadId!, "ready");
    await f.service.tick();
    expect((await f.board()).tasks[0]).toMatchObject({ status: "review", run: { reviewSha: SHA } });
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

  test("a successful merge with a failed removal write recovers the approved merging state", () => fixture(async (f) => {
    await f.service.create({ title: "task", projectId: "one" });
    await enable(f.service);
    const task = await f.ready();
    f.failNextRemovalWrite();
    await expect(f.service.action({ action: "approve", id: task.id, reviewSha: SHA })).rejects.toThrow("状态保存失败");
    expect(f.merges).toHaveLength(1);
    expect((await f.board()).tasks[0]?.status).toBe("merging");
    expect((await f.board()).tasks[0]?.run).toMatchObject({ reviewSha: SHA, merged: true });
    await expect(f.service.action({ action: "complete", id: task.id })).rejects.toThrow("合并中");
    await f.service.tick();
    // 恢复时不再重复合并，只补做推送、清理和移除。
    expect((await f.board()).tasks).toEqual([]);
    expect(f.merges).toEqual([SHA]);
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
