import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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

test("HTTP → T3 dispatch → task worktree → manual approval → develop → next TODO", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "yb-todo-flow-")));
  const repo = join(dir, "repo");
  await mkdir(repo);
  await git(repo, "init", "-b", "develop");
  await git(repo, "config", "user.name", "TODO fixture");
  await git(repo, "config", "user.email", "fixture@example.invalid");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "result.txt"), "base\n");
  await git(repo, "add", "result.txt");
  await git(repo, "commit", "-m", "fixture base");
  const original = await git(repo, "rev-parse", "develop");
  const modelSelection = { instanceId: "fixture-provider", model: "fixture-model" };
  const fake = fakeT3({ projects: [{ id: "project", title: "Fixture", workspaceRoot: repo, defaultModelSelection: modelSelection }], environmentId: "test-env" });
  const dispatched = () => fake.calls.filter((call) => call.name === "t3_thread_launch").map((call) => call.args.title);
  const t3 = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fake.handle });
  const automation = new T3Automation({ getUrl: async () => `http://127.0.0.1:${t3.port}/`, getToken: async () => fake.token });
  const service = new TaskService({ dataDir: join(dir, "data"), automation, git: new TaskGit({ dataDir: join(dir, "data") }) });
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
    await call("/api/tasks", "POST", { title: "high", projectId: "project", priority: 0 });
    await call("/api/tasks/action", "POST", { action: "project", projectId: "project", enabled: true });
    await service.tick();
    expect(dispatched()).toEqual(["high"]);
    const active = (await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.status === "running")!;
    expect(active.run!.worktreePath).not.toBe(repo);
    expect(await git(repo, "symbolic-ref", "--short", "HEAD")).toBe("develop");
    await writeFile(join(active.run!.worktreePath, "result.txt"), "task change\n");
    await git(active.run!.worktreePath, "add", "result.txt");
    await git(active.run!.worktreePath, "commit", "-m", "fixture task result");
    expect(fake.threads.find((thread) => thread.threadId === active.run!.threadId)?.worktreePath).toBe(active.run!.worktreePath);
    fake.complete(active.run!.threadId!, "变更及检查已完成");
    await service.tick();
    expect((await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.id === active.id)?.status).toBe("review");
    expect(await git(repo, "rev-parse", "develop")).toBe(original);
    expect(dispatched()).toHaveLength(1);
    const review = await call<TaskReview>(`/api/tasks/review?id=${encodeURIComponent(active.id)}`);
    expect(review.diff).toContain("+task change");
    expect(review.task.run?.summary).toBe("变更及检查已完成");
    await call("/api/tasks/action", "POST", { action: "approve", id: active.id, reviewSha: review.headSha });
    await service.tick();
    expect(await git(repo, "rev-parse", "develop")).toBe(review.headSha);
    expect(dispatched()).toEqual(["high", "low"]);
    const board = await call<TaskBoard>("/api/tasks");
    expect(board.tasks.find((task) => task.id === active.id)?.status).toBe("done");
    expect(board.tasks.find((task) => task.title === "low")?.run?.baseSha).toBe(review.headSha);
  } finally {
    await service.stop(); await http.stop(); await automation.close(); await t3.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
