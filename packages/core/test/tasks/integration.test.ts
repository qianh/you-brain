import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { T3Automation } from "../../src/deck/t3/automation.js";
import { fakeT3 } from "../deck/t3-mcp-fake.js";
import { TaskGit } from "../../src/tasks/git.js";
import { TaskService } from "../../src/tasks/service.js";
import { startDaemonHttp } from "../../src/http/server.js";
import type { HttpDeps } from "../../src/http/deps.js";
import type { TaskBoard, TaskReview } from "../../src/tasks/types.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`fixture git ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}

test("HTTP manual start → T3 plan → parallel TODO → review → develop pushed → tasks retained after Git cleanup", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "yb-todo-flow-")));
  const repo = join(dir, "repo");
  const homeDir = join(dir, "home");
  await mkdir(repo);
  await mkdir(homeDir);
  await git(repo, "init", "-b", "develop");
  await git(repo, "config", "user.name", "TODO fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "result.txt"), "base\n");
  await git(repo, "add", "result.txt");
  await git(repo, "commit", "-m", "fixture base");
  const original = await git(repo, "rev-parse", "develop");
  const remote = join(dir, "origin.git");
  await mkdir(remote);
  await git(remote, "init", "--bare", "-b", "develop");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "develop");
  const exists = (path: string) => access(path).then(() => true, () => false);
  const modelSelection = { instanceId: "codex", model: "dzg/gpt-6.2-sol" };
  const fake = fakeT3({ projects: [{ id: "project", title: "Fixture", workspaceRoot: repo, defaultModelSelection: modelSelection }], environmentId: "test-env" });
  const dispatched = () => fake.calls.filter((call) => call.name === "t3_thread_launch").map((call) => call.args.title);
  const t3 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fake.handle });
  const automation = new T3Automation({ getUrl: async () => `http://127.0.0.1:${t3.port}/`, getToken: async () => fake.token });
  const service = new TaskService({
    dataDir: join(dir, "data"),
    homeDir,
    automation,
    git: new TaskGit({ dataDir: join(dir, "data") }),
    classifyTask: async (input) => (input.title.includes("修复") ? "other" : "requirement"),
  });
  const http = await startDaemonHttp({ dataDir: join(dir, "data"), deps: { tasks: service } as unknown as HttpDeps });
  const call = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(http.baseUrl + path, { method,
      headers: { authorization: `Bearer ${http.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`fixture HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  };
  try {
    await call("/api/tasks", "POST", { title: "low", projectId: "project", priority: 3 });
    const queued = await call<TaskBoard>("/api/tasks", "POST", { title: "high", description: "新增按周导出报表功能", projectId: "project", priority: 0 });
    const high = queued.tasks.find((task) => task.title === "high")!;
    const launched = await call<TaskBoard>("/api/tasks/action", "POST", { action: "start", id: high.id });
    const active = launched.tasks.find((task) => task.id === high.id)!;
    expect(active.status).toBe("planning");
    const run = active.run;
    if (!run?.worktreePath || !run.threadId) throw new Error("Expected a linked worktree and T3 thread");
    const projectThread = fake.threads.find((thread) => thread.threadId === run.threadId)!;
    expect(projectThread).toMatchObject({ interactionMode: "plan", worktreePath: run.worktreePath });
    const firstMessage = projectThread.items[0]?.text ?? "";
    expect(firstMessage.startsWith("/skill:grill-me\n\n")).toBe(true);
    expect(firstMessage).toContain("新增按周导出报表功能");
    expect(firstMessage).toContain("已判定为需求型 TODO");
    expect(firstMessage).toContain("每次只问一个问题，给出推荐答案并等待回复");
    fake.complete(run.threadId, "建议导出 CSV，是否需要其他格式？");
    await call("/api/tasks/action", "POST", { action: "project", projectId: "project", enabled: true });
    await service.tick();
    // 每个任务有独立工作树：高优先级仍在确认需求时，低优先级也被并行领取。
    expect(dispatched()).toEqual(["high", "low"]);
    const low = (await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.title === "low")!;
    expect(low).toMatchObject({ status: "running", run: { baseSha: original } });
    const planning = (await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.id === active.id)!;
    expect(planning).toMatchObject({ status: "planning", run: { reviewSha: null } });
    await automation.followup(run.threadId, "CSV 就够了", "project-requirements-fixture");
    fake.complete(run.threadId, "将按周导出 CSV，请确认实施计划");
    await service.tick();
    expect((await service.board()).tasks.find((task) => task.id === active.id)?.status).toBe("planning");
    projectThread.interactionMode = "default";
    await automation.followup(run.threadId, "确认需求，按计划执行", "project-plan-fixture");
    expect(run.worktreePath).not.toBe(repo);
    expect(await git(repo, "symbolic-ref", "--short", "HEAD")).toBe("develop");
    await writeFile(join(run.worktreePath, "result.txt"), "task change\n");
    await git(run.worktreePath, "add", "result.txt");
    await git(run.worktreePath, "commit", "-m", "fixture task result");
    for (let update = 0; update < 65; update++) {
      projectThread.items.push({ type: "assistant_message", runId: projectThread.latestRunId, text: `进度 ${update + 1}` });
    }
    fake.complete(run.threadId, "变更及检查已完成");
    await automation.followup(run.threadId, "这次改动新增接口了吗？", "project-followup-fixture");
    fake.complete(run.threadId, "没有新增接口");
    await service.tick();
    expect((await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.id === active.id)?.status).toBe("review");
    expect(await git(repo, "rev-parse", "develop")).toBe(original);
    expect(dispatched()).toHaveLength(2);
    const review = await call<TaskReview>(`/api/tasks/review?id=${encodeURIComponent(active.id)}`);
    expect(review.diff).toContain("+task change");
    expect(review.task.run?.summary).toBe("没有新增接口");
    await call("/api/tasks/action", "POST", { action: "approve", id: active.id, reviewSha: review.headSha });
    await service.tick();
    expect(await git(repo, "rev-parse", "develop")).toBe(review.headSha);
    expect(dispatched()).toEqual(["high", "low"]);
    expect(await git(remote, "rev-parse", "develop")).toBe(review.headSha);
    const board = await call<TaskBoard>("/api/tasks");
    expect(board.tasks.find((task) => task.id === active.id)).toMatchObject({
      title: active.title, status: "done", run: { merged: true, reviewSha: review.headSha, threadUrl: run.threadUrl },
    });
    expect(await git(repo, "branch", "--list", run.branch!)).toBe("");
    expect(await exists(run.worktreePath)).toBe(false);

    // 低优先级任务从旧 develop 出发：确认时先把新 develop 合入任务分支，再快进、推送、清理，一步完成。
    const lowRun = low.run!;
    if (!lowRun.worktreePath || !lowRun.threadId) throw new Error("Expected the parallel task worktree");
    await writeFile(join(lowRun.worktreePath, "low.txt"), "low change\n");
    await git(lowRun.worktreePath, "add", "low.txt");
    await git(lowRun.worktreePath, "commit", "-m", "fixture low result");
    const lowHead = await git(lowRun.worktreePath, "rev-parse", "HEAD");
    fake.complete(lowRun.threadId, "低优先级完成");
    await service.tick();
    const lowReview = await call<TaskReview>(`/api/tasks/review?id=${encodeURIComponent(low.id)}`);
    expect(lowReview.headSha).toBe(lowHead);
    expect(lowReview.diff).toContain("+low change");
    expect(lowReview.diff).not.toContain("task change");
    const merged = await call<TaskBoard>("/api/tasks/action", "POST", { action: "approve", id: low.id, reviewSha: lowHead });
    const developHead = await git(repo, "rev-parse", "develop");
    expect(merged.tasks.find((task) => task.id === low.id)).toMatchObject({ status: "done", run: { merged: true, reviewSha: developHead } });
    expect(await git(repo, "rev-parse", "develop^1")).toBe(lowHead);
    expect(await git(repo, "rev-parse", "develop^2")).toBe(review.headSha);
    expect(await git(repo, "show", "develop:low.txt")).toBe("low change");
    expect(await git(repo, "show", "develop:result.txt")).toBe("task change");
    expect(await git(remote, "rev-parse", "develop")).toBe(developHead);
    expect(await git(repo, "branch", "--list", lowRun.branch!)).toBe("");
    expect(await exists(lowRun.worktreePath)).toBe(false);
    const lowThread = fake.threads.find((thread) => thread.threadId === lowRun.threadId)!;
    expect(lowThread.items[0]?.text).not.toContain("grill-me");
    expect(lowThread.items.some((item) => String(item.text ?? "").includes("合入当前任务分支"))).toBe(false);

    const created = await call<TaskBoard>("/api/tasks", "POST", { title: "standalone" });
    const id = created.tasks.find((task) => task.title === "standalone")!.id;
    const started = await call<TaskBoard>("/api/tasks/action", "POST", { action: "start", id });
    const standalone = started.tasks.find((task) => task.id === id)!;
    expect(standalone).toMatchObject({ projectId: null, status: "planning", run: { projectCwd: homeDir, worktreePath: null } });
    const thread = fake.threads.find((item) => item.threadId === standalone.run?.threadId)!;
    expect(thread).toMatchObject({ interactionMode: "plan", worktreePath: null });
    fake.complete(thread.threadId, "请确认需求和计划");
    await service.tick();
    expect((await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.id === id)?.status).toBe("planning");
    thread.interactionMode = "default";
    await automation.followup(thread.threadId, "确认，按计划执行", "approval-fixture");
    fake.complete(thread.threadId, "按计划完成");
    await service.tick();
    expect((await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.id === id)).toMatchObject({ status: "done", run: { reviewSha: null } });
    expect(await git(repo, "rev-parse", "develop")).toBe(developHead);
  } finally {
    await service.stop(); await http.stop(); await automation.close(); await t3.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("HTTP manual start dispatches Antigravity /grill-me for requirement TODOs and skips grill-me for non-requirement TODOs", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "yb-todo-provider-")));
  const repo = join(dir, "repo");
  const homeDir = join(dir, "home");
  await mkdir(repo);
  await mkdir(homeDir);
  await git(repo, "init", "-b", "develop");
  await git(repo, "config", "user.name", "TODO fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "result.txt"), "base\n");
  await git(repo, "add", "result.txt");
  await git(repo, "commit", "-m", "fixture base");

  const fake = fakeT3({
    projects: [{ id: "agy-proj", title: "Agy", workspaceRoot: repo, defaultModelSelection: { instanceId: "antigravity", model: "gemini-4-neon" } }],
    providers: [{ providerInstanceId: "antigravity", driverKind: "antigravity", runtimeModes: ["approval-required", "auto-accept-edits", "full-access"] }],
    environmentId: "test-env",
  });
  const t3 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fake.handle });
  const automation = new T3Automation({ getUrl: async () => `http://127.0.0.1:${t3.port}/`, getToken: async () => fake.token });
  const service = new TaskService({
    dataDir: join(dir, "data"),
    homeDir,
    automation,
    git: new TaskGit({ dataDir: join(dir, "data") }),
    classifyTask: async (input) => (input.title.includes("修复") ? "other" : "requirement"),
  });
  const http = await startDaemonHttp({ dataDir: join(dir, "data"), deps: { tasks: service } as unknown as HttpDeps });
  const call = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(http.baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${http.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`fixture HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  };
  try {
    const createdReq = await call<TaskBoard>("/api/tasks", "POST", {
      title: "新增多维筛选",
      description: "在页面工具栏增加状态和标签组合筛选",
      projectId: "agy-proj",
      priority: 1,
    });
    const reqTask = createdReq.tasks.find((t) => t.title === "新增多维筛选")!;
    const reqBoard = await call<TaskBoard>("/api/tasks/action", "POST", { action: "start", id: reqTask.id });
    const startedReq = reqBoard.tasks.find((t) => t.id === reqTask.id)!;
    expect(startedReq.status).toBe("planning");
    const reqThread = fake.threads.find((t) => t.threadId === startedReq.run?.threadId)!;
    expect(reqThread.interactionMode).toBe("plan");
    expect(String(reqThread.items[0]?.text ?? "").startsWith("/grill-me\n\n")).toBe(true);

    const createdFix = await call<TaskBoard>("/api/tasks", "POST", {
      title: "修复导出文件名乱码",
      description: "修正 UTF-8 filename header 编码",
      projectId: "agy-proj",
      priority: 1,
    });
    const fixTask = createdFix.tasks.find((t) => t.title === "修复导出文件名乱码")!;
    const fixBoard = await call<TaskBoard>("/api/tasks/action", "POST", { action: "start", id: fixTask.id });
    const startedFix = fixBoard.tasks.find((t) => t.id === fixTask.id)!;
    expect(startedFix.status).toBe("planning");
    const fixThread = fake.threads.find((t) => t.threadId === startedFix.run?.threadId)!;
    expect(fixThread.interactionMode).toBe("plan");
    const fixFirstMessage = String(fixThread.items[0]?.text ?? "");
    expect(fixFirstMessage.startsWith("/")).toBe(false);
    expect(fixFirstMessage).not.toContain("grill-me");
  } finally {
    await service.stop(); await http.stop(); await automation.close(); await t3.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
