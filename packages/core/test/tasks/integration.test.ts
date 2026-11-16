import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { T3Automation } from "../../src/deck/t3/automation.js";
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
  interface Thread {
    id: string; projectId: string; modelSelection: object; updatedAt: string;
    worktreePath: string; branch: string; messages: Array<{ id: string; role: string; text: string; streaming: boolean; createdAt: string }>;
    latestTurn: { state: string; requestedAt: string; assistantMessageId: string | null };
    session: { status: string; activeTurnId: string | null; lastError: null };
  }
  const threads = new Map<string, Thread>();
  const dispatched: string[] = [];
  const modelSelection = { instanceId: "fixture-provider", model: "fixture-model" };
  const t3 = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/t3/environment") return Response.json({ environmentId: "test-env" });
    if (path === "/api/orchestration/shell") return Response.json({
      projects: [{ id: "project", title: "Fixture", workspaceRoot: repo, defaultModelSelection: modelSelection }],
      threads: [...threads.values()],
    });
    if (path.startsWith("/api/orchestration/threads/")) return Response.json({ thread: threads.get(path.split("/").at(-1)!) });
    if (path === "/api/orchestration/dispatch") {
      const body = await request.json() as {
        threadId: string; createdAt: string; message: { messageId: string; text: string };
        bootstrap: { createThread: { projectId: string; branch: string; worktreePath: string; title: string } };
      };
      const created = body.bootstrap.createThread;
      dispatched.push(created.title);
      threads.set(body.threadId, {
        id: body.threadId, projectId: created.projectId, modelSelection, updatedAt: body.createdAt,
        worktreePath: created.worktreePath, branch: created.branch,
        messages: [{ id: body.message.messageId, role: "user", text: body.message.text, streaming: false, createdAt: body.createdAt }],
        latestTurn: { state: "running", requestedAt: body.createdAt, assistantMessageId: null },
        session: { status: "running", activeTurnId: "turn", lastError: null },
      });
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  } });
  const automation = new T3Automation({ getUrl: async () => `http://127.0.0.1:${t3.port}/`, getToken: async () => "fixture-only" });
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
    expect(dispatched).toEqual(["high"]);
    const active = (await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.status === "running")!;
    expect(active.run!.worktreePath).not.toBe(repo);
    expect(await git(repo, "symbolic-ref", "--short", "HEAD")).toBe("develop");
    await writeFile(join(active.run!.worktreePath, "result.txt"), "task change\n");
    await git(active.run!.worktreePath, "add", "result.txt");
    await git(active.run!.worktreePath, "commit", "-m", "fixture task result");
    const thread = threads.get(active.run!.threadId!)!;
    const finished = new Date(Date.parse(thread.updatedAt) + 1_000).toISOString();
    thread.messages.push({ id: "assistant-result", role: "assistant", text: "变更及检查已完成", streaming: false, createdAt: finished });
    thread.latestTurn = { state: "completed", requestedAt: thread.updatedAt, assistantMessageId: "assistant-result" };
    thread.session = { status: "ready", activeTurnId: null, lastError: null };
    await service.tick();
    expect((await call<TaskBoard>("/api/tasks")).tasks.find((task) => task.id === active.id)?.status).toBe("review");
    expect(await git(repo, "rev-parse", "develop")).toBe(original);
    expect(dispatched).toHaveLength(1);
    const review = await call<TaskReview>(`/api/tasks/review?id=${encodeURIComponent(active.id)}`);
    expect(review.diff).toContain("+task change");
    expect(review.task.run?.summary).toBe("变更及检查已完成");
    await call("/api/tasks/action", "POST", { action: "approve", id: active.id, reviewSha: review.headSha });
    await service.tick();
    expect(await git(repo, "rev-parse", "develop")).toBe(review.headSha);
    expect(dispatched).toEqual(["high", "low"]);
    const board = await call<TaskBoard>("/api/tasks");
    expect(board.tasks.find((task) => task.id === active.id)?.status).toBe("done");
    expect(board.tasks.find((task) => task.title === "low")?.run?.baseSha).toBe(review.headSha);
  } finally {
    await service.stop(); await http.stop(); await automation.close(); await t3.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
