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

test("HTTP manual start → T3 plan → parallel TODO → review → develop pushed → behind task synced, merged and removed", async () => {
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
  const modelSelection = { instanceId: "fixture-provider", model: "fixture-model" };
  const fake = fakeT3({ projects: [{ id: "project", title: "Fixture", workspaceRoot: repo, defaultModelSelection: modelSelection }], environmentId: "test-env" });
  const dispatched = () => fake.calls.filter((call) => call.name === "t3_thread_launch").map((call) => call.args.title);
  const t3 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fake.handle });
  const automation = new T3Automation({ getUrl: async () => `http://127.0.0.1:${t3.port}/`, getToken: async () => fake.token });
  const service = new TaskService({ dataDir: join(dir, "data"), homeDir, automation, git: new TaskGit({ dataDir: join(dir, "data") }) });
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
    const queued = await call<TaskBoard>("/api/tasks", "POST", { title: "high", projectId: "project", priority: 0 });
    const high = queued.tasks.find((task) => task.title === "high")!;
    const launched = await call<TaskBoard>("/api/tasks/action", "POST", { action: "start", id: high.id });
    const active = launched.tasks.find((task) => task.id === high.id)!;
    expect(active.status).toBe("planning");
    const run = active.run;
    if (!run?.worktreePath || !run.threadId) throw new Error("Expected a linked worktree and T3 thread");
    const projectThread = fake.threads.find((thread) => thread.threadId === run.threadId)!;
    expect(projectThread).toMatchObject({ interactionMode: "plan", worktreePath: run.worktreePath });
    fake.complete(run.threadId, "请确认需求和计划");
    await call("/api/tasks/action", "POST", { action: "project", projectId: "project", enabled: true });
    await service.tick();
    // 每个任务有独立工作树：高优先级仍在确认需求时，低优先级也被并行领取。
    expect(dispatched()).toEqual(["high", "low"]);
    const low = (await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.title === "low")!;
    expect(low).toMatchObject({ status: "running", run: { baseSha: original } });
    const planning = (await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.id === active.id)!;
    expect(planning).toMatchObject({ status: "planning", run: { reviewSha: null } });
    projectThread.interactionMode = "default";
    await automation.followup(run.threadId, "确认需求，按计划执行", "project-plan-fixture");
    expect(run.worktreePath).not.toBe(repo);
    expect(await git(repo, "symbolic-ref", "--short", "HEAD")).toBe("develop");
    await writeFile(join(run.worktreePath, "result.txt"), "task change\n");
    await git(run.worktreePath, "add", "result.txt");
    await git(run.worktreePath, "commit", "-m", "fixture task result");
    fake.complete(run.threadId, "变更及检查已完成");
    await service.tick();
    expect((await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.id === active.id)?.status).toBe("review");
    expect(await git(repo, "rev-parse", "develop")).toBe(original);
    expect(dispatched()).toHaveLength(2);
    const review = await call<TaskReview>(`/api/tasks/review?id=${encodeURIComponent(active.id)}`);
    expect(review.diff).toContain("+task change");
    expect(review.task.run?.summary).toBe("变更及检查已完成");
    await call("/api/tasks/action", "POST", { action: "approve", id: active.id, reviewSha: review.headSha });
    await service.tick();
    expect(await git(repo, "rev-parse", "develop")).toBe(review.headSha);
    expect(dispatched()).toEqual(["high", "low"]);
    // 合并后自动推送 develop，删除任务分支和工作树，并从列表移除这个 TODO。
    expect(await git(remote, "rev-parse", "develop")).toBe(review.headSha);
    const board = await call<TaskBoard>("/api/tasks");
    expect(board.tasks.find((task) => task.id === active.id)).toBeUndefined();
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
    expect(merged.tasks.find((task) => task.id === low.id)).toBeUndefined();
    const developHead = await git(repo, "rev-parse", "develop");
    expect(await git(repo, "rev-parse", "develop^1")).toBe(lowHead);
    expect(await git(repo, "rev-parse", "develop^2")).toBe(review.headSha);
    expect(await git(repo, "show", "develop:low.txt")).toBe("low change");
    expect(await git(repo, "show", "develop:result.txt")).toBe("task change");
    expect(await git(remote, "rev-parse", "develop")).toBe(developHead);
    expect(await git(repo, "branch", "--list", lowRun.branch!)).toBe("");
    expect(await exists(lowRun.worktreePath)).toBe(false);
    const lowThread = fake.threads.find((thread) => thread.threadId === lowRun.threadId)!;
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
