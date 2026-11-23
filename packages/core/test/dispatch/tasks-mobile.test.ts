import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DispatchCommandSchema,
  generateKeyPair,
  newNonce,
  signCommand,
  type CommandSigningFields,
} from "@you-brain/protocol";

import { DispatchExecutor, type DispatchT3Port } from "../../src/dispatch/index.js";
import { TaskService } from "../../src/tasks/service.js";
import type { TaskAutomationPort, TaskBoard, TaskGitPort, TaskReview } from "../../src/tasks/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeSignedFrame(
  keys: { privateKey: string },
  from: string,
  to: string,
  kind: string,
  args: unknown,
  now: number,
  cmdId = `cmd-${Math.random().toString(36).slice(2)}`,
) {
  const fields: CommandSigningFields = {
    cmdId,
    from,
    to,
    ts: now,
    nonce: newNonce(),
    cmd: { kind, args },
  };
  return { t: "cmd" as const, ...fields, sig: signCommand(keys.privateKey, fields) };
}

function fakeT3Port(): DispatchT3Port {
  return {
    projects: async () => [
      { id: "p1", name: "alpha", cwd: "/repo/alpha" },
      { id: "p2", name: "beta", cwd: "/repo/beta" },
    ],
    launchThread: async () => ({ threadId: "th-1", threadUrl: "http://127.0.0.1:3773/env/th-1" }),
    followup: async () => {},
    inspect: async () => ({ state: "ready", summary: "ok" }),
    threadStates: async () => [],
    latestAnswer: async () => "",
  };
}

function fakeAutomation(): TaskAutomationPort {
  let seq = 0;
  return {
    projects: async () => [
      { id: "p1", name: "alpha", cwd: "/repo/alpha" },
      { id: "p2", name: "beta", cwd: "/repo/beta" },
    ],
    createProject: async (input) => ({
      id: `new-${++seq}`,
      name: input.name,
      cwd: input.cwd ?? `/tmp/${input.name}`,
    }),
    start: async () => ({
      threadId: `th-${++seq}`,
      threadUrl: `http://127.0.0.1:3773/env/th-${seq}`,
    }),
    inspect: async () => ({ state: "ready", summary: "完成修改并运行测试通过" }),
    followup: async () => {},
  };
}

function fakeGit(diffText = "+hello\n"): TaskGitPort {
  return {
    prepare: async (project, taskId) => ({
      branch: `task/${taskId}`,
      worktreePath: `${project.cwd}/.wt/${taskId}`,
      baseSha: "a".repeat(40),
    }),
    isMerged: async () => false,
    review: async () => ({
      headSha: "b".repeat(40),
      baseSha: "a".repeat(40),
      stat: " src/a.ts | 2 ++\n 1 file changed",
      diff: diffText,
      truncated: false,
    }),
    merge: async () => {},
    syncDevelop: async () => "current",
    publish: async () => "pushed",
    cleanup: async () => {},
  };
}

describe("dispatch tasks.* remote TODO management", () => {
  test("protocol schemas validate tasks.* commands and reject invalid payloads", () => {
    expect(DispatchCommandSchema.safeParse({ kind: "tasks.board", args: {} }).success).toBe(true);
    expect(DispatchCommandSchema.safeParse({
      kind: "tasks.create",
      args: { title: "修复登录态", description: "详情", projectId: "p1", priority: 1 },
    }).success).toBe(true);
    // projectId 与 newProject 互斥
    expect(DispatchCommandSchema.safeParse({
      kind: "tasks.create",
      args: { title: "冲突", projectId: "p1", newProject: { name: "x" } },
    }).success).toBe(false);
    expect(DispatchCommandSchema.safeParse({
      kind: "tasks.action",
      args: { action: "approve", id: "t1", reviewSha: "not-a-sha" },
    }).success).toBe(false);
    expect(DispatchCommandSchema.safeParse({
      kind: "tasks.action",
      args: { action: "approve", id: "t1", reviewSha: "a".repeat(40) },
    }).success).toBe(true);
  });

  test("mobile can read, create, edit, start, review, reject/approve and toggle projects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ubrain-tasks-mobile-"));
    tempDirs.push(dir);

    const now = 1_760_000_000_000;
    const phoneKeys = generateKeyPair();
    const tasks = new TaskService({
      dataDir: dir,
      automation: fakeAutomation(),
      git: fakeGit(),
      now: () => new Date(now),
    });

    const executor = new DispatchExecutor({
      dataDir: dir,
      deviceId: "dev-mac",
      now: () => now,
      t3: fakeT3Port(),
      tasksPort: tasks,
      emitEvent: () => {},
    });
    await executor.updatePolicy({
      enabled: true,
      allProjects: true,
      allowedSenders: [{ deviceId: "dev-phone", name: "Phone", publicKey: phoneKeys.publicKey }],
    });

    const send = (kind: string, args: unknown) =>
      executor.handle(makeSignedFrame(phoneKeys, "dev-phone", "dev-mac", kind, args, now));

    // 1. Read initial board
    const boardRes = await send("tasks.board", {});
    expect(boardRes.ok).toBe(true);
    const initialBoard = (boardRes as { ok: true; result: TaskBoard }).result;
    expect(initialBoard.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(initialBoard.tasks).toEqual([]);

    // 2. Create a TODO
    const createdRes = await send("tasks.create", {
      title: "接入手机端 TODO",
      description: "支持远程增删改查和核对",
      projectId: "p1",
      priority: 1,
    });
    expect(createdRes.ok).toBe(true);
    const createdBoard = (createdRes as { ok: true; result: TaskBoard }).result;
    expect(createdBoard.tasks).toHaveLength(1);
    const taskId = createdBoard.tasks[0]!.id;
    expect(createdBoard.tasks[0]!.priority).toBe(1);

    // 3. Update queued TODO
    const updatedRes = await send("tasks.update", {
      id: taskId,
      title: "接入手机端 TODO（已完善）",
      priority: 0,
    });
    expect(updatedRes.ok).toBe(true);
    const updatedBoard = (updatedRes as { ok: true; result: TaskBoard }).result;
    expect(updatedBoard.tasks[0]!.title).toBe("接入手机端 TODO（已完善）");
    expect(updatedBoard.tasks[0]!.priority).toBe(0);

    // 4. Toggle project auto-processing
    const enableRes = await send("tasks.action", { action: "project", projectId: "p2", enabled: true });
    expect(enableRes.ok).toBe(true);
    expect((enableRes as { ok: true; result: TaskBoard }).result.projects.find((p) => p.id === "p2")?.enabled).toBe(true);

    // 5. Start task manually -> moves to planning, then tick advances to review
    const startRes = await send("tasks.action", { action: "start", id: taskId });
    expect(startRes.ok).toBe(true);
    expect((startRes as { ok: true; result: TaskBoard }).result.tasks[0]!.status).toBe("planning");

    // Editing a non-queued task surfaces TaskError cleanly
    const badEdit = await send("tasks.update", { id: taskId, title: "不能改" });
    expect(badEdit.ok).toBe(false);
    if (!badEdit.ok) expect(badEdit.error).toContain("待处理");

    // Advance via tick to review
    await tasks.tick();
    const reviewRes = await send("tasks.review", { id: taskId });
    expect(reviewRes.ok).toBe(true);
    const review = (reviewRes as { ok: true; result: TaskReview }).result;
    expect(review.headSha).toBe("b".repeat(40));
    expect(review.diff).toBe("+hello\n");

    // Approve & merge
    const approveRes = await send("tasks.action", {
      action: "approve",
      id: taskId,
      reviewSha: review.headSha,
    });
    expect(approveRes.ok).toBe(true);
    expect((approveRes as { ok: true; result: TaskBoard }).result.tasks).toHaveLength(0);

    // Read-only commands (tasks.board / tasks.review) should not bloat ledger.json
    const ledgerText = await readFile(join(dir, "dispatch", "ledger.json"), "utf8");
    expect(ledgerText).not.toContain("+hello\\n");

    await tasks.stop();
  });

  test("enforces project allowlist and truncates oversized review diffs safely below relay limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ubrain-tasks-cap-"));
    tempDirs.push(dir);

    const now = 1_760_000_000_000;
    const phoneKeys = generateKeyPair();
    const hugeDiff = "+".repeat(300_000);
    const tasks = new TaskService({
      dataDir: dir,
      automation: fakeAutomation(),
      git: fakeGit(hugeDiff),
      now: () => new Date(now),
    });

    // Seed one task in p1 (allowed) and one in p2 (not allowed)
    const b1 = await tasks.create({ title: "允许的项目任务", projectId: "p1", priority: 1 });
    await tasks.create({ title: "未允许的项目任务", projectId: "p2", priority: 2 });
    const p1TaskId = b1.tasks[0]!.id;
    await tasks.action({ action: "start", id: p1TaskId });
    await tasks.tick();

    const executor = new DispatchExecutor({
      dataDir: dir,
      deviceId: "dev-mac",
      now: () => now,
      t3: fakeT3Port(),
      tasksPort: tasks,
      emitEvent: () => {},
    });
    await executor.updatePolicy({
      enabled: true,
      allProjects: false,
      allowedProjects: ["p1"],
      allowedSenders: [{ deviceId: "dev-phone", name: "Phone", publicKey: phoneKeys.publicKey }],
    });

    const send = (kind: string, args: unknown) =>
      executor.handle(makeSignedFrame(phoneKeys, "dev-phone", "dev-mac", kind, args, now));

    // Board only exposes allowed project p1 and its tasks
    const boardRes = await send("tasks.board", {});
    expect(boardRes.ok).toBe(true);
    const board = (boardRes as { ok: true; result: TaskBoard }).result;
    expect(board.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(board.tasks.map((t) => t.title)).toEqual(["允许的项目任务"]);

    // Rejects creating in disallowed project
    const denied = await send("tasks.create", { title: "越权任务", projectId: "p2" });
    expect(denied.ok).toBe(false);

    // Oversized diff is truncated to fit well inside relay's 256 KB result frame limit
    const reviewRes = await send("tasks.review", { id: p1TaskId });
    expect(reviewRes.ok).toBe(true);
    const review = (reviewRes as { ok: true; result: TaskReview }).result;
    expect(review.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(review), "utf8")).toBeLessThanOrEqual(190 * 1024);

    await tasks.stop();
  });
});
