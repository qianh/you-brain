import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { TaskGit } from "../../src/tasks/git.js";
import type { TaskProject, TaskWorktreeRun } from "../../src/tasks/types.js";

let dir: string;
let repo: string;
let git: TaskGit;
let project: TaskProject;

function command(cwd: string, args: string[]): string {
  const result = spawnSync("/usr/bin/git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed`);
  return result.stdout.trim();
}

function commit(cwd: string, name = "task.txt", text = "implemented\n"): string {
  writeFileSync(join(cwd, name), text);
  command(cwd, ["add", "--", name]);
  command(cwd, ["commit", "-m", "fixture"]);
  return command(cwd, ["rev-parse", "HEAD"]);
}

async function task(id = "one"): Promise<TaskWorktreeRun> {
  return { ...await git.prepare(project, id), projectCwd: project.cwd, threadId: null, threadUrl: null, reviewSha: null, summary: "", error: null };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yb-task-git-"));
  repo = join(dir, "project");
  command(dir, ["init", "--initial-branch=develop", repo]);
  command(repo, ["config", "user.name", "Task test"]);
  command(repo, ["config", "user.email", "task-test@example.invalid"]);
  commit(repo, "initial.txt", "initial\n");
  project = { id: "project", name: "Project", cwd: repo, enabled: true };
  git = new TaskGit({ dataDir: join(dir, "data") });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TaskGit", () => {
  test("隔离任务分支，原工作区的未提交内容不受影响，prepare 可恢复", async () => {
    writeFileSync(join(repo, "initial.txt"), "user edits\n");
    writeFileSync(join(repo, "untracked.txt"), "user file\n");
    const run = await task();
    expect(command(repo, ["branch", "--show-current"])).toBe("develop");
    expect(readFileSync(join(repo, "initial.txt"), "utf8")).toBe("user edits\n");
    expect(readFileSync(join(run.worktreePath, "initial.txt"), "utf8")).toBe("initial\n");
    expect(await git.prepare(project, "one")).toEqual({ branch: run.branch, worktreePath: run.worktreePath, baseSha: run.baseSha });
    expect(existsSync(join(repo, "untracked.txt"))).toBe(true);
  });

  test("review 给出提交和差异，人工确认后快进 develop，重复合并可恢复", async () => {
    const run = await task();
    const head = commit(run.worktreePath);
    const review = await git.review(project, run);
    expect(review.headSha).toBe(head);
    expect(review.baseSha).toBe(run.baseSha);
    expect(review.diff).toContain("+implemented");
    expect(command(repo, ["rev-parse", "develop"])).toBe(run.baseSha);
    await git.merge(project, { ...run, reviewSha: head }, head);
    expect(command(repo, ["rev-parse", "develop"])).toBe(head);
    expect(readFileSync(join(repo, "task.txt"), "utf8")).toBe("implemented\n");
    await git.merge(project, { ...run, reviewSha: head }, head);
    expect(existsSync(run.worktreePath)).toBe(true);
  });

  test("只有未核对的提交不能直接合并，空任务也不能核对", async () => {
    const run = await task();
    await expect(git.review(project, run)).rejects.toThrow("没有可核对的提交");
    const head = commit(run.worktreePath);
    await expect(git.merge(project, run, head)).rejects.toThrow("尚未核对");
    expect(command(repo, ["rev-parse", "develop"])).toBe(run.baseSha);
  });

  test("develop 未检出时只推进 ref，保留其他分支及工作区", async () => {
    command(repo, ["checkout", "-b", "user-work"]);
    writeFileSync(join(repo, "initial.txt"), "keep me\n");
    const run = await task();
    const head = commit(run.worktreePath);
    await git.merge(project, { ...run, reviewSha: head }, head);
    expect(command(repo, ["branch", "--show-current"])).toBe("user-work");
    expect(command(repo, ["rev-parse", "develop"])).toBe(head);
    expect(readFileSync(join(repo, "initial.txt"), "utf8")).toBe("keep me\n");
    expect(existsSync(join(repo, "task.txt"))).toBe(false);
  });

  test("develop 在另一工作树中检出时更新那个工作树，不切换原分支", async () => {
    command(repo, ["checkout", "-b", "user-work"]);
    const other = join(dir, "develop-worktree");
    command(repo, ["worktree", "add", other, "develop"]);
    const run = await task();
    const head = commit(run.worktreePath);
    await git.merge(project, { ...run, reviewSha: head }, head);
    expect(command(repo, ["branch", "--show-current"])).toBe("user-work");
    expect(readFileSync(join(other, "task.txt"), "utf8")).toBe("implemented\n");
  });

  test("拒绝覆盖 develop 工作区的未提交内容", async () => {
    const run = await task();
    const head = commit(run.worktreePath);
    writeFileSync(join(repo, "initial.txt"), "human changes\n");
    await expect(git.merge(project, { ...run, reviewSha: head }, head)).rejects.toThrow("develop 工作区有未提交");
    expect(command(repo, ["rev-parse", "develop"])).toBe(run.baseSha);
    expect(readFileSync(join(repo, "initial.txt"), "utf8")).toBe("human changes\n");
  });

  test("任务未提交、切换分支、核对后新增提交均阻止合并", async () => {
    const run = await task();
    const head = commit(run.worktreePath);
    writeFileSync(join(run.worktreePath, "task.txt"), "unfinished\n");
    await expect(git.review(project, run)).rejects.toThrow("任务工作树有未提交");
    await expect(git.merge(project, { ...run, reviewSha: head }, head)).rejects.toThrow("任务工作树有未提交");
    const next = commit(run.worktreePath, "task.txt", "changed\n");
    await expect(git.merge(project, { ...run, reviewSha: head }, head)).rejects.toThrow("任务提交已变化");
    await expect(git.merge(project, { ...run, reviewSha: head }, next)).rejects.toThrow("任务提交已变化");
    command(run.worktreePath, ["checkout", "-b", "unexpected"]);
    await expect(git.review(project, run)).rejects.toThrow("预期分支");
    expect(command(repo, ["rev-parse", "develop"])).toBe(run.baseSha);
  });

  test("develop 分叉不影响任务核对，只有合并才要求同步", async () => {
    const run = await task();
    const head = commit(run.worktreePath);
    const original = await git.review(project, run);
    const develop = commit(repo, "other.txt", "other work\n");
    expect(await git.review(project, run)).toEqual(original);
    expect(original.stat).toContain("task.txt");
    expect(original.diff).not.toContain("other.txt");
    await expect(git.merge(project, { ...run, reviewSha: head }, head)).rejects.toThrow("任务分支尚未包含最新的 develop");
    expect(command(repo, ["rev-parse", "develop"])).toBe(develop);
    expect(command(run.worktreePath, ["rev-parse", "HEAD"])).toBe(head);

    command(run.worktreePath, ["merge", "--no-edit", "develop"]);
    const synced = await git.review(project, run);
    expect(synced.headSha).not.toBe(head);
    expect(synced.baseSha).toBe(develop);
    expect(synced.diff).toBe(original.diff);
    await expect(git.merge(project, { ...run, reviewSha: head }, head)).rejects.toThrow("任务提交已变化");
    await git.merge(project, { ...run, reviewSha: synced.headSha }, synced.headSha);
    expect(command(repo, ["rev-parse", "develop"])).toBe(synced.headSha);
  });

  test("develop 前进但任务没有提交，仍然等待任务提交", async () => {
    const run = await task();
    commit(repo, "other.txt", "other work\n");
    expect(await git.isMerged(project, run)).toBe(false);
    await expect(git.review(project, run)).rejects.toThrow("没有可核对的提交");
  });

  test("识别外部的非快进合并，保留 develop 原来的合并提交", async () => {
    const run = await task();
    const head = commit(run.worktreePath);
    commit(repo, "other.txt", "other work\n");
    expect(await git.isMerged(project, run)).toBe(false);
    command(repo, ["merge", "--no-ff", "--no-edit", run.branch]);
    const merged = command(repo, ["rev-parse", "develop"]);
    expect(merged).not.toBe(head);
    expect(await git.isMerged(project, run)).toBe(true);
    await expect(git.review(project, run)).rejects.toThrow("任务提交已合入本地 develop");
    await git.merge(project, { ...run, reviewSha: head }, head);
    expect(command(repo, ["rev-parse", "develop"])).toBe(merged);

    const next = commit(run.worktreePath, "task.txt", "unmerged changes\n");
    expect(await git.isMerged(project, { ...run, reviewSha: head })).toBe(false);
    expect((await git.review(project, run)).headSha).toBe(next);
  });

  test("develop 被移走或退回到任务起点之前，仍按任务起点核对", async () => {
    const oldBase = command(repo, ["rev-parse", "HEAD"]);
    commit(repo, "already-there.txt", "pre-existing work\n");
    const run = await task();
    const head = commit(run.worktreePath);
    const original = await git.review(project, run);
    command(repo, ["branch", "-m", "archived-develop"]);
    expect(await git.review(project, run)).toEqual(original);
    command(repo, ["branch", "develop", oldBase]);
    expect(await git.review(project, run)).toEqual(original);
    await expect(git.merge(project, { ...run, reviewSha: head }, head)).rejects.toThrow("develop 已退回到任务起点之前");
    expect(command(repo, ["rev-parse", "develop"])).toBe(oldBase);
  });

  test("拒绝未知已存在任务分支，不覆写原提交", async () => {
    command(repo, ["branch", "task/one"]);
    await expect(task()).rejects.toThrow("不属于此任务");
    expect(command(repo, ["rev-parse", "task/one"])).toBe(command(repo, ["rev-parse", "develop"]));
  });

  test("自有分支工作树缺失时可恢复，任务原提交不变", async () => {
    const run = await task();
    command(repo, ["worktree", "remove", run.worktreePath]);
    mkdirSync(run.worktreePath);
    expect(await git.prepare(project, "one")).toEqual({ branch: run.branch, worktreePath: run.worktreePath, baseSha: run.baseSha });
    expect(command(run.worktreePath, ["rev-parse", "HEAD"])).toBe(run.baseSha);
  });

  test("项目目录变更后不能核对或合并旧任务", async () => {
    const run = await task();
    const head = commit(run.worktreePath);
    const moved = { ...project, cwd: join(dir, "other") };
    await expect(git.review(moved, run)).rejects.toThrow("T3 项目目录已变化");
    await expect(git.merge(moved, run, head)).rejects.toThrow("T3 项目目录已变化");
  });

  test("Git 不覆盖目标工作区里被忽略但将被任务新增的文件", async () => {
    commit(repo, ".gitignore", "local.txt\n");
    const run = await task();
    writeFileSync(join(run.worktreePath, "local.txt"), "task content\n");
    command(run.worktreePath, ["add", "-f", "--", "local.txt"]);
    command(run.worktreePath, ["commit", "-m", "fixture"]);
    const head = command(run.worktreePath, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "local.txt"), "user ignored file\n");
    await expect(git.merge(project, { ...run, reviewSha: head }, head)).rejects.toThrow("Git merge 失败");
    expect(readFileSync(join(repo, "local.txt"), "utf8")).toBe("user ignored file\n");
    expect(command(repo, ["rev-parse", "develop"])).toBe(run.baseSha);
  });

  test("拒绝无 develop 的项目、路径穿越及子目录", async () => {
    const child = join(repo, "nested");
    mkdirSync(child);
    await expect(git.prepare({ ...project, cwd: child }, "one")).rejects.toThrow("Git 仓库根目录");
    command(repo, ["branch", "-m", "main"]);
    await expect(task()).rejects.toThrow("缺少本地 develop");
    await expect(task("../escape")).rejects.toThrow("任务编号");
    await expect(git.prepare({ ...project, cwd: "/tmp" }, "one")).rejects.toThrow();
  });

  test("拒绝敏感文件差异，不返回内容", async () => {
    const run = await task();
    const head = commit(run.worktreePath, ".env.local", "EXAMPLE_TEST_KEY=fixture-value\n");
    await expect(git.review(project, run)).rejects.toThrow("凭据或密钥文件");
    await expect(git.merge(project, { ...run, reviewSha: head }, head)).rejects.toThrow("凭据或密钥文件");
    expect(command(repo, ["rev-parse", "develop"])).toBe(run.baseSha);
  });

  test("大差异明确截断，仍返回核对 SHA", async () => {
    const run = await task();
    const head = commit(run.worktreePath, "large.txt", "fixture content\n".repeat(20_000));
    const review = await git.review(project, run);
    expect(review.headSha).toBe(head);
    expect(review.truncated).toBe(true);
    expect(Buffer.byteLength(review.diff)).toBeLessThanOrEqual(128 * 1024 + 3);
  });
});
