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

import { startRelayServer, type RelayServer } from "../../../../services/telegram-relay/src/server.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { enrollRelay, TelegramRelayClient } from "../../src/deck/telegram/relay.js";
import { DispatchExecutor, type DispatchT3Port } from "../../src/dispatch/index.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { TaskService } from "../../src/tasks/service.js";
import type { TaskAutomationPort, TaskBoard, TaskGitPort, TaskReview } from "../../src/tasks/types.js";
import { makeDaemonDirs, throwingEmbedder } from "../daemon/helpers.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
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

  test("real YouBrainDaemon wires TaskService into DispatchExecutor on startup", async () => {
    const relayKey = "relay-key-tasks-daemon-test";
    const telegram = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ ok: true, result: { id: 1, username: "test_bot", first_name: "Test" } }),
    });
    cleanups.push(() => telegram.stop(true));

    const relayDir = await mkdtemp(join(tmpdir(), "yb-tasks-relay-"));
    tempDirs.push(relayDir);
    const relay: RelayServer = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      botToken: "123456:TEST-TOKEN",
      relayKey,
      dataDir: relayDir,
      telegramApi: `http://127.0.0.1:${telegram.port}`,
    });
    cleanups.push(() => relay.stop());
    const relayUrl = `http://127.0.0.1:${relay.port}`;

    const dirs = await makeDaemonDirs("yb-tasks-daemon-");
    tempDirs.push(dirs.root);
    const daemon: YouBrainDaemon = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "mac-todo-test",
      drive: new MemoryDrive(),
      llm: null,
      embedder: throwingEmbedder,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    cleanups.push(() => daemon.stop());

    const authHeaders = {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    };

    const createInvite = async (): Promise<string> => {
      const res = await fetch(`${relayUrl}/admin/invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${relayKey}` },
      });
      const body = (await res.json()) as { code: string };
      return body.code;
    };

    // Enroll real daemon into relay
    const daemonEnroll = await fetch(`${daemon.baseUrl}/api/deck/telegram`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        action: "enroll-relay",
        url: relayUrl,
        code: await createInvite(),
        name: "Mac-Daemon",
      }),
    });
    expect(daemonEnroll.status).toBe(200);

    // Enroll simulated mobile peer into relay
    const phoneKeys = generateKeyPair();
    const phoneId = "phone-mobile-0001";
    const { token: phoneToken } = await enrollRelay(relayUrl, {
      code: await createInvite(),
      deviceId: phoneId,
      name: "Test Phone",
      publicKey: phoneKeys.publicKey,
    });

    type CmdResFrame = { cmdId: string; ok: boolean; result?: unknown; error?: string };
    const pending = new Map<string, (frame: CmdResFrame) => void>();
    let targetDeviceId: string | null = null;
    let phoneConnected = false;

    const phone = new TelegramRelayClient({
      url: relayUrl,
      token: phoneToken,
      deviceId: phoneId,
      name: "Test Phone",
      onState: (state) => {
        const peer = state.devices.find((d) => d.id !== phoneId && d.online);
        if (peer) targetDeviceId = peer.id;
      },
      onMessage: () => undefined,
      onConnection: (status) => {
        if (status === "ok") phoneConnected = true;
      },
      onDispatchFrame: (frame) => {
        if (frame.t === "cmdres" && typeof frame.cmdId === "string") {
          const parsed: CmdResFrame = {
            cmdId: frame.cmdId,
            ok: frame.ok === true,
            ...(frame.result !== undefined ? { result: frame.result } : {}),
            ...(typeof frame.error === "string" ? { error: frame.error } : {}),
          };
          pending.get(frame.cmdId)?.(parsed);
          pending.delete(frame.cmdId);
        }
      },
    });
    phone.start();
    cleanups.push(() => phone.stop());

    const deadline = Date.now() + 8_000;
    while ((!phoneConnected || !targetDeviceId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(phoneConnected).toBe(true);
    expect(targetDeviceId).not.toBeNull();

    // Wait until daemon sees the mobile peer on the relay, then trust it and enable dispatch
    let trusted = false;
    while (!trusted && Date.now() < deadline) {
      const trustRes = await fetch(`${daemon.baseUrl}/api/dispatch/trust-device`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ deviceId: phoneId }),
      });
      if (trustRes.status === 200) {
        trusted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(trusted).toBe(true);

    const policyRes = await fetch(`${daemon.baseUrl}/api/dispatch/policy`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        enabled: true,
        allProjects: true,
      }),
    });
    expect(policyRes.status).toBe(200);

    const sendRemote = async (kind: string, args: unknown) => {
      const frame = makeSignedFrame(phoneKeys, phoneId, targetDeviceId!, kind, args, Date.now());
      const response = new Promise<CmdResFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(frame.cmdId);
          reject(new Error(`timeout waiting for ${kind}`));
        }, 8_000);
        pending.set(frame.cmdId, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
      });
      await phone.request("cmd", {
        cmdId: frame.cmdId,
        to: frame.to,
        cmd: frame.cmd,
        ts: frame.ts,
        nonce: frame.nonce,
        sig: frame.sig,
      });
      return response;
    };

    const boardRes = await sendRemote("tasks.board", {});
    expect(boardRes.ok).toBe(true);

    const createRes = await sendRemote("tasks.create", {
      title: "手机端远程 TODO",
      description: "验证真实 daemon 启动后 tasksPort 已接入",
      projectId: null,
      priority: 1,
    });
    expect(createRes.ok).toBe(true);
    if (createRes.ok) {
      const board = createRes.result as TaskBoard;
      expect(board.tasks.some((t) => t.title === "手机端远程 TODO")).toBe(true);
    }

    const httpTasks = await fetch(`${daemon.baseUrl}/api/tasks`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(httpTasks.status).toBe(200);
    const localBoard = (await httpTasks.json()) as TaskBoard;
    expect(localBoard.tasks.some((t) => t.title === "手机端远程 TODO")).toBe(true);
  }, 15_000);
});
