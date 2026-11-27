import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { T3Automation } from "../../src/deck/t3/automation.js";
import { TaskGit } from "../../src/tasks/git.js";
import { PROJECT_PARALLEL_LIMIT, TaskService, type TaskServiceOptions } from "../../src/tasks/service.js";
import type { TaskRepositoryRun } from "../../src/tasks/types.js";
import { fakeT3 } from "../deck/t3-mcp-fake.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["/usr/bin/git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`fixture git ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "yb-todo-batch-")));
  const model = { instanceId: "fixture-provider", model: "fixture-model" };
  const projects = await Promise.all(["api", "web"].map(async (id) => {
    const cwd = join(dir, id);
    await mkdir(cwd);
    await git(cwd, "init", "-b", "develop");
    await git(cwd, "config", "user.name", "TODO fixture");
    await git(cwd, "config", "user.email", "fixture@example.invalid");
    await git(cwd, "config", "commit.gpgsign", "false");
    await git(cwd, "commit", "--allow-empty", "-m", "fixture base");
    const base = await git(cwd, "rev-parse", "develop");
    return { id, name: id.toUpperCase(), cwd, base, enabled: true };
  }));
  const [api, web] = projects as [typeof projects[number], typeof projects[number]];
  const alias = join(dir, "api-alias");
  await symlink(api.cwd, alias);
  const fake = fakeT3({ projects: [...projects, { ...api, id: "alias", cwd: alias }].map(({ id, name, cwd }) => ({ id, title: name, workspaceRoot: cwd, defaultModelSelection: model })) });
  const automation = new T3Automation({ getUrl: async () => "http://127.0.0.1:3773/", getToken: async () => fake.token, fetch: fake.fetch });
  const taskGit = new TaskGit({ dataDir: dir });
  const options: TaskServiceOptions = { dataDir: dir, automation, git: taskGit };
  let service = new TaskService(options);
  const getTask = async (id: string) => (await service.board()).tasks.find((task) => task.id === id)!;
  const createBatch = async () => {
    const board = await service.create({ title: "跨仓变更", projectId: "web", relatedProjectIds: ["api"] });
    return board.tasks.at(-1)!.id;
  };
  const startBatch = async () => {
    const id = await createBatch();
    const board = await service.action({ action: "start", id });
    const run = board.tasks.find((task) => task.id === id)!.run!;
    if (run.branch === null || !run.batch || !run.threadId) throw new Error("Expected batch worktrees and a single thread");
    const [primary, secondary] = run.batch.repositories as [TaskRepositoryRun, TaskRepositoryRun];
    const thread = fake.threads.find((item) => item.threadId === run.threadId)!;
    thread.interactionMode = "default";
    fake.complete(run.threadId, "请确认计划");
    await automation.followup(run.threadId, "确认，开始执行。", `${id}-approve-plan`);
    return { id, run, primary, secondary, thread };
  };
  return { dir, api, web, fake, automation, options, taskGit, getTask, createBatch, startBatch,
    get service() { return service; },
    restart: async () => { await service.stop(); service = new TaskService(options); },
    close: async () => { await service.stop(); await automation.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function commit(cwd: string, file: string): Promise<string> {
  await writeFile(join(cwd, file), `${file} contents\n`);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
}

test("prepares all worktrees before starting one T3 thread; rejects stale reviews and delivers secondary-only changes", async () => {
  const f = await fixture();
  const prepare = f.taskGit.prepare.bind(f.taskGit);
  let fail = true;
  f.taskGit.prepare = async (project, id) => {
    if (fail && project.id === "api") throw new Error("fixture prepare failure");
    return prepare(project, id);
  };
  try {
    await expect(f.service.create({ title: "duplicate repo", projectId: "api", relatedProjectIds: ["alias"] })).rejects.toThrow("同一个 Git 仓库");
    const id = await f.createBatch();
    expect((await f.service.action({ action: "start", id })).tasks[0]?.status).toBe("failed");
    expect(f.fake.threads).toHaveLength(0);
    fail = false;
    await f.service.action({ action: "retry", id });
    await f.service.tick();
    const run = (await f.getTask(id)).run!;
    if (run.branch === null || !run.batch || !run.threadId) throw new Error("Expected dispatched batch");
    const secondary = run.batch.repositories[1]!;
    expect(await git(secondary.worktreePath, "branch", "--show-current")).toBe(secondary.branch);
    expect(f.fake.threads).toHaveLength(1);
    const thread = f.fake.threads[0]!;
    expect(thread).toMatchObject({ projectId: "web", worktreePath: run.worktreePath, branch: run.branch });
    expect(thread.items[0]?.text).toContain(secondary.worktreePath);
    thread.interactionMode = "default";
    f.fake.complete(thread.threadId, "请确认计划");
    await f.automation.followup(thread.threadId, "确认，开始执行。", `${id}-approve-plan`);
    await commit(secondary.worktreePath, "first.txt");
    f.fake.complete(thread.threadId, "secondary done");
    await f.service.tick();
    const review = (await f.service.review(id)).batch!;
    expect(review.repositories).toMatchObject([{ projectId: "web", diff: null }, { projectId: "api", diff: { diff: expect.stringContaining("+first.txt contents") } }]);
    const newHead = await commit(secondary.worktreePath, "second.txt");
    await expect(f.service.action({ action: "approve", id, reviewSha: newHead })).rejects.toThrow("逐仓核对");
    await expect(f.service.action({ action: "approveBatch", id, reviewToken: review.token })).rejects.toThrow("仓库变更已变化");
    expect(await git(f.api.cwd, "rev-parse", "develop")).toBe(f.api.base);
    const latest = (await f.service.review(id)).batch!;
    const completed = await f.service.action({ action: "approveBatch", id, reviewToken: latest.token });
    expect(completed.tasks).toMatchObject([{ id, status: "done", run: { batch: { repositories: [{ phase: "skipped" }, { phase: "delivered" }] } } }]);
    expect(await git(f.api.cwd, "rev-parse", "develop")).toBe(newHead);
    expect(await git(f.web.cwd, "rev-parse", "develop")).toBe(f.web.base);
    await expect(access(run.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(secondary.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
}, 30_000);

test("a dirty secondary worktree blocks the entire approval and is never discarded", async () => {
  const f = await fixture();
  try {
    const { id, primary, secondary, thread } = await f.startBatch();
    await commit(primary.worktreePath, "primary.txt");
    f.fake.complete(thread.threadId, "done");
    await f.service.tick();
    const token = (await f.service.review(id)).batch!.token;
    const dirtyPath = join(secondary.worktreePath, "unfinished.txt");
    await writeFile(dirtyPath, "keep\n");
    await expect(f.service.action({ action: "approveBatch", id, reviewToken: token })).rejects.toThrow("API：任务工作树有未提交");
    expect(await f.getTask(id)).toMatchObject({ status: "failed", worktreeBlock: { untracked: 1 } });
    expect(await git(f.web.cwd, "rev-parse", "develop")).toBe(f.web.base);
    expect(await Bun.file(dirtyPath).text()).toBe("keep\n");
    await commit(secondary.worktreePath, "unfinished.txt");
    await f.service.tick();
    expect((await f.service.review(id)).batch?.token).not.toBe(token);
  } finally { await f.close(); }
}, 30_000);

test("restarts after partial delivery and only resumes the failed push and outstanding cleanup", async () => {
  const f = await fixture();
  const publish = f.taskGit.publish.bind(f.taskGit);
  const merge = f.taskGit.merge.bind(f.taskGit);
  const pushes: string[] = [];
  const merges: string[] = [];
  let fail = true;
  f.taskGit.publish = async (project, ...args) => {
    pushes.push(project.id);
    if (fail && project.id === "api") throw new Error("fixture push failure");
    return publish(project, ...args);
  };
  f.taskGit.merge = async (project, ...args) => { merges.push(project.id); await merge(project, ...args); };
  try {
    const remotes = new Map<string, string>();
    for (const project of [f.web, f.api]) {
      const remote = join(f.dir, `${project.id}-origin.git`);
      await git(f.dir, "init", "--bare", "-b", "develop", remote);
      await git(project.cwd, "remote", "add", "origin", remote);
      await git(project.cwd, "push", "-u", "origin", "develop");
      remotes.set(project.id, remote);
    }
    const { id, primary, secondary, thread } = await f.startBatch();
    const primarySha = await commit(primary.worktreePath, "primary.txt");
    const secondarySha = await commit(secondary.worktreePath, "secondary.txt");
    f.fake.complete(thread.threadId, "done");
    await f.service.tick();
    const token = (await f.service.review(id)).batch!.token;
    await expect(f.service.action({ action: "approveBatch", id, reviewToken: token })).rejects.toThrow("API：fixture push failure");
    expect((await f.getTask(id)).run).toMatchObject({ batch: { approved: true, repositories: [{ phase: "published" }, { phase: "merged" }] } });
    expect(await git(f.web.cwd, "rev-parse", "develop")).toBe(primarySha);
    expect(await git(f.api.cwd, "rev-parse", "develop")).toBe(secondarySha);
    expect(await git(remotes.get("web")!, "rev-parse", "develop")).toBe(primarySha);
    expect(await git(remotes.get("api")!, "rev-parse", "develop")).toBe(f.api.base);
    fail = false;
    await f.restart();
    expect((await f.service.action({ action: "retry", id })).tasks).toMatchObject([{ id, status: "done" }]);
    expect(merges).toEqual(["web", "api"]);
    expect(pushes).toEqual(["web", "api", "api"]);
    expect(await git(remotes.get("api")!, "rev-parse", "develop")).toBe(secondarySha);
    await expect(access(primary.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(secondary.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.close(); }
}, 30_000);

test("syncing a secondary repo requires fresh approval and does not merge already completed repos again", async () => {
  const f = await fixture();
  const merge = f.taskGit.merge.bind(f.taskGit);
  const merges: string[] = [];
  f.taskGit.merge = async (project, ...args) => { merges.push(project.id); await merge(project, ...args); };
  try {
    const { id, primary, secondary, thread } = await f.startBatch();
    const primarySha = await commit(primary.worktreePath, "primary.txt");
    const secondarySha = await commit(secondary.worktreePath, "secondary.txt");
    const advanced = await commit(f.api.cwd, "other-task.txt");
    f.fake.complete(thread.threadId, "done");
    await f.service.tick();
    const original = (await f.service.review(id)).batch!;
    await expect(f.service.action({ action: "approveBatch", id, reviewToken: original.token })).rejects.toThrow("重新确认");
    expect(await git(f.web.cwd, "rev-parse", "develop")).toBe(primarySha);
    expect(await git(f.api.cwd, "rev-parse", "develop")).toBe(advanced);
    const next = (await f.service.review(id)).batch!;
    expect(next.token).not.toBe(original.token);
    expect(next.repositories).toMatchObject([{ phase: "merged", diff: null }, { phase: "pending", diff: { baseSha: advanced } }]);
    expect(next.repositories[1]?.diff?.headSha).not.toBe(secondarySha);
    await f.service.action({ action: "approveBatch", id, reviewToken: next.token });
    expect(merges).toEqual(["web", "api", "api"]);
    expect(await git(f.api.cwd, "show", "develop:secondary.txt")).toBe("secondary.txt contents");
  } finally { await f.close(); }
}, 30_000);

test("cleanup of an unchanged repo is recoverable when the worktree is already gone", async () => {
  const f = await fixture();
  const cleanup = f.taskGit.cleanup.bind(f.taskGit);
  let fail = true;
  f.taskGit.cleanup = async (project, ...args) => {
    await cleanup(project, ...args);
    if (fail && project.id === "web") throw new Error("interrupted after cleanup");
  };
  try {
    const { id, primary, secondary, thread } = await f.startBatch();
    await commit(secondary.worktreePath, "secondary.txt");
    f.fake.complete(thread.threadId, "done");
    await f.service.tick();
    const review = (await f.service.review(id)).batch!;
    await expect(f.service.action({ action: "approveBatch", id, reviewToken: review.token })).rejects.toThrow("interrupted after cleanup");
    expect((await f.getTask(id)).run).toMatchObject({ batch: { repositories: [{ phase: "skipping" }, { phase: "published" }] } });
    await expect(access(primary.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    fail = false;
    await f.restart();
    expect((await f.service.action({ action: "retry", id })).tasks).toMatchObject([{ id, status: "done" }]);
  } finally { await f.close(); }
}, 30_000);

test("overlapping tasks count against each repository, but only the primary project picks up a batch", async () => {
  const f = await fixture();
  try {
    const batchId = await f.createBatch();
    await f.service.action({ action: "project", projectId: "api", enabled: true });
    await f.service.tick();
    expect(f.fake.threads).toHaveLength(0);
    for (let index = 0; index < PROJECT_PARALLEL_LIMIT; index++) await f.service.create({ title: `API ${index}`, projectId: "api" });
    await f.service.tick();
    expect(f.fake.threads).toHaveLength(PROJECT_PARALLEL_LIMIT);
    await expect(f.service.action({ action: "start", id: batchId })).rejects.toThrow("关联项目已有 3 个 TODO");
    await f.service.action({ action: "project", projectId: "web", enabled: true });
    await f.service.tick();
    expect((await f.getTask(batchId)).status).toBe("queued");
    const first = (await f.service.board()).tasks.find((task) => task.title === "API 0")!;
    await f.service.action({ action: "complete", id: first.id });
    await f.service.tick();
    expect((await f.getTask(batchId)).status).toBe("running");
    const board = await f.service.create({ title: "extra", projectId: "alias" });
    await expect(f.service.action({ action: "start", id: board.tasks.at(-1)!.id })).rejects.toThrow("项目已有 3 个 TODO");
    expect(f.fake.threads.filter((item) => item.title === "跨仓变更").map((item) => item.projectId)).toEqual(["web"]);
  } finally { await f.close(); }
}, 30_000);
