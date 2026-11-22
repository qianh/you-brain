import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { TaskGitPort, TaskProject, TaskReview, TaskWorktreeBlock, TaskWorktreeRun } from "./types.js";

const DIFF_LIMIT = 128 * 1024;
const COMMAND_LIMIT = 1024 * 1024;
const PUSH_TIMEOUT_MS = 120_000;
const SHA = /^[a-f0-9]{40,64}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/u;

interface GitResult { text: string; err: string; code: number; truncated: boolean }
interface Worktree { path: string; branch: string | null }
interface Owner {
  version: 1;
  repo: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
}

/** 任务只在自己的 worktree 里执行；合并入口只能接收已由人核对的提交。 */
/** 会话这一轮结束了但分支上还没有提交：多半是 AI 在等用户确认方案或回答问题，不算出错。 */
export class TaskNoCommitError extends Error {
  constructor() {
    super("任务还没有可核对的提交");
    this.name = "TaskNoCommitError";
  }
}

export class TaskMergeBlockedError extends Error {}

/** 任务分支不含最新 develop，不能快进；可先把 develop 合入任务分支再重新核对。 */
export class TaskBehindDevelopError extends TaskMergeBlockedError {}

export class TaskDirtyWorktreeError extends Error {
  constructor(readonly counts: TaskWorktreeBlock) {
    super("任务工作树有未提交或未跟踪的内容，请在 T3 中确认后重新检查");
  }
}

export class TaskAlreadyMergedError extends Error {
  constructor() {
    super("任务提交已合入本地 develop");
    this.name = "TaskAlreadyMergedError";
  }
}

export class TaskGit implements TaskGitPort {
  readonly #options: { dataDir: string; env?: NodeJS.ProcessEnv };
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: { dataDir: string; env?: NodeJS.ProcessEnv }) {
    this.#options = options;
  }

  async prepare(project: TaskProject, taskId: string): Promise<Pick<TaskWorktreeRun, "branch" | "worktreePath" | "baseSha">> {
    if (!TASK_ID.test(taskId)) throw new Error("任务编号不正确");
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      const location = await this.#location(repo, taskId);
      const branch = `task/${taskId}`;
      let owner = await this.#readOwner(location.ownerFile);
      if (owner !== null) this.#assertOwner(owner, repo, branch, location.worktreePath);
      const entries = await this.#worktrees(repo);
      const existing = entries.find((entry) => resolve(entry.path) === location.worktreePath);
      const branchExists = await this.#hasRef(repo, `refs/heads/${branch}`);
      if (owner === null) {
        if (existing || branchExists) throw new Error("任务分支或工作树已存在但不属于此任务，已保留原内容");
        const baseSha = await this.#develop(repo);
        owner = { version: 1, repo, branch, worktreePath: location.worktreePath, baseSha };
        await writeFile(location.ownerFile, JSON.stringify(owner), { encoding: "utf8", mode: 0o600, flag: "wx" });
      }
      if (existing) {
        if (existing.branch !== `refs/heads/${branch}`) throw new Error("任务工作树已切换到其他分支，不能自动恢复");
        await this.#assertWorktree(repo, owner);
        return { branch, worktreePath: owner.worktreePath, baseSha: owner.baseSha };
      }
      if (entries.some((entry) => entry.branch === `refs/heads/${branch}`)) {
        throw new Error("任务分支正在其他工作树中使用，已保留现场");
      }
      try {
        const info = await lstat(location.worktreePath);
        if (!info.isDirectory() || (await readdir(location.worktreePath)).length !== 0) {
          throw new Error("任务工作树目录已被其他内容占用，已保留原内容");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (branchExists) {
        if (await this.#sha(repo, `refs/heads/${branch}`) !== owner.baseSha) {
          throw new Error("任务分支已有变更但工作树缺失，需要人工恢复");
        }
        await this.#git(repo, ["worktree", "add", location.worktreePath, branch]);
      } else {
        await this.#git(repo, ["worktree", "add", "-b", branch, location.worktreePath, owner.baseSha]);
      }
      await this.#assertWorktree(repo, owner);
      return { branch, worktreePath: owner.worktreePath, baseSha: owner.baseSha };
    });
  }

  async isMerged(project: TaskProject, run: TaskWorktreeRun): Promise<boolean> {
    this.#assertProject(project, run);
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      const developRef = "refs/heads/develop";
      if (!(await this.#hasRef(repo, developRef))) return false;
      const headSha = await this.#sha(repo, `refs/heads/${run.branch}`);
      if (headSha === run.baseSha || !(await this.#isAncestor(repo, headSha, developRef))) return false;
      return (await this.#verifyRun(repo, run)) === headSha && await this.#isAncestor(repo, headSha, developRef);
    });
  }

  async review(project: TaskProject, run: TaskWorktreeRun): Promise<Omit<TaskReview, "task">> {
    this.#assertProject(project, run);
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      const headSha = await this.#verifyRun(repo, run);
      if (run.baseSha === headSha) throw new TaskNoCommitError();
      const baseSha = await this.#reviewBase(repo, run.baseSha, headSha);
      if (baseSha === headSha) throw new TaskAlreadyMergedError();
      await this.#safeChanges(repo, baseSha, headSha);
      const stat = (await this.#git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--stat", baseSha, headSha, "--"])).text;
      const diff = await this.#git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseSha, headSha, "--"], { limit: DIFF_LIMIT });
      return { headSha, baseSha, stat, diff: diff.text, truncated: diff.truncated };
    });
  }

  async merge(project: TaskProject, run: TaskWorktreeRun, approvedSha: string): Promise<void> {
    this.#assertProject(project, run);
    if (!SHA.test(approvedSha)) throw new Error("核对提交编号不正确");
    if (run.reviewSha === null) throw new Error("任务尚未核对，请先核对提交后再合并");
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      const headSha = await this.#verifyRun(repo, run);
      if (approvedSha !== headSha || run.reviewSha !== approvedSha) {
        throw new Error("任务提交已变化，请重新核对后再合并");
      }
      const develop = await this.#develop(repo);
      // 崩溃可能发生在 Git 成功后、队列写回前。相同提交可以安全补记完成。
      if (develop === approvedSha) return;
      if (!(await this.#isAncestor(repo, develop, approvedSha))) {
        if (approvedSha !== run.baseSha && await this.#isAncestor(repo, approvedSha, develop)) return;
        throw new TaskBehindDevelopError("任务分支尚未包含最新的 develop。请在 T3 中将本地 develop 同步到任务分支，再重新核对。");
      }
      if (!(await this.#isAncestor(repo, run.baseSha, develop))) {
        throw new TaskMergeBlockedError("本地 develop 已退回到任务起点之前，合并会带入未核对的提交。请在 T3 中检查分支历史。");
      }
      await this.#safeChanges(repo, develop, approvedSha);
      const checkedOut = (await this.#worktrees(repo)).filter((entry) => entry.branch === "refs/heads/develop");
      if (checkedOut.length > 1) throw new Error("develop 同时在多个工作树中使用，不能自动合并");
      const target = checkedOut[0];
      if (target) {
        await this.#clean(target.path, "develop 工作区有未提交或未跟踪的内容，已保留原内容");
        if ((await this.#git(target.path, ["symbolic-ref", "-q", "HEAD"])).text.trim() !== "refs/heads/develop") {
          throw new Error("develop 工作区已切换分支，请重新核对后再合并");
        }
        if (await this.#sha(target.path, "HEAD") !== develop) throw new Error("develop 提交已变化，请重新核对后再合并");
        await this.#git(target.path, ["merge", "--ff-only", "--no-autostash", "--no-edit", "--no-overwrite-ignore", approvedSha]);
      } else {
        // 未检出的分支只推进 ref；旧值比较避免覆盖同时发生的更新。
        await this.#git(repo, ["update-ref", "refs/heads/develop", approvedSha, develop]);
      }
      if (await this.#develop(repo) !== approvedSha) throw new Error("develop 合并结果发生变化，请人工检查");
    });
  }

  /**
   * 把本地 develop 合入已核对的任务分支（普通合并，不 rebase）。
   * 冲突时撤销合并、恢复到核对版本，交给 T3 解决；只在任务工作树内操作，不改 develop。
   */
  async syncDevelop(project: TaskProject, run: TaskWorktreeRun, approvedSha: string): Promise<"merged" | "conflict" | "current"> {
    this.#assertProject(project, run);
    if (!SHA.test(approvedSha)) throw new Error("核对提交编号不正确");
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      const headSha = await this.#verifyRun(repo, run);
      if (headSha !== approvedSha) throw new Error("任务提交已变化，请重新核对后再合并");
      const develop = await this.#develop(repo);
      if (await this.#isAncestor(repo, develop, headSha)) return "current";
      if (!(await this.#isAncestor(repo, run.baseSha, develop))) {
        throw new TaskMergeBlockedError("本地 develop 已退回到任务起点之前，合并会带入未核对的提交。请在 T3 中检查分支历史。");
      }
      const merged = await this.#git(run.worktreePath, [
        "merge", "--no-ff", "--no-edit", "--no-autostash", "--no-overwrite-ignore",
        "-m", `同步 develop 到 ${run.branch}`, develop,
      ], { allowFailure: true });
      if (merged.code === 0) {
        await this.#clean(run.worktreePath, "合入 develop 后任务工作树不干净，已保留现场");
        const next = await this.#sha(run.worktreePath, "HEAD");
        if (next === headSha) return "current";
        if (!(await this.#isAncestor(repo, headSha, next)) || !(await this.#isAncestor(repo, develop, next))) {
          throw new Error("合入 develop 的结果不符合预期，已保留现场");
        }
        return "merged";
      }
      // 冲突或其他失败：撤销到核对版本，由 T3 在原会话中合并并解决冲突。
      await this.#git(run.worktreePath, ["merge", "--abort"], { allowFailure: true });
      await this.#clean(run.worktreePath, "自动合入 develop 失败且未能还原工作树，已保留现场，请在 T3 中处理");
      if (await this.#sha(run.worktreePath, "HEAD") !== headSha) throw new Error("自动合入 develop 失败且任务分支已变化，已保留现场");
      return "conflict";
    });
  }

  /**
   * 把本地 develop 推到远端：只推 develop 一个分支，不强推。
   * 远端领先、被拒绝或网络、认证失败都会抛错并带上 Git 的原因，由人处理后重试；本地 develop 不受影响。
   */
  async publish(project: TaskProject, run: TaskWorktreeRun): Promise<"pushed" | "no-remote"> {
    this.#assertProject(project, run);
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      await this.#develop(repo);
      const configured = (await this.#git(repo, ["config", "--get", "branch.develop.remote"], { allowFailure: true })).text.trim();
      const remote = configured !== "" ? configured : "origin";
      const remotes = (await this.#git(repo, ["remote"])).text.split("\n").map((item) => item.trim()).filter(Boolean);
      if (!remotes.includes(remote)) return "no-remote";
      const pushed = await this.#git(repo, ["push", remote, "refs/heads/develop:refs/heads/develop"], { allowFailure: true, stderr: true, timeoutMs: PUSH_TIMEOUT_MS });
      if (pushed.code !== 0) {
        throw new Error(`已合并到本地 develop，但推送到 ${remote} 失败：${redact(pushed.err).slice(0, 300) || `退出码 ${pushed.code}`}。请人工处理后点“重试”`);
      }
      return "pushed";
    });
  }

  /** 合并并推送完成后删除任务工作树、任务分支和归属记录；每一步都容忍已经做过。 */
  async cleanup(project: TaskProject, run: TaskWorktreeRun): Promise<void> {
    this.#assertProject(project, run);
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      const id = run.branch.startsWith("task/") ? run.branch.slice(5) : "";
      if (!TASK_ID.test(id)) throw new Error("任务分支记录不正确");
      const location = await this.#location(repo, id);
      const owner = await this.#readOwner(location.ownerFile);
      if (owner === null) return;
      this.#assertOwner(owner, repo, run.branch, location.worktreePath);
      const branchRef = `refs/heads/${owner.branch}`;
      const branchSha = (await this.#hasRef(repo, branchRef)) ? await this.#sha(repo, branchRef) : null;
      // 只删已经完整进入 develop 的分支，避免丢掉没合并的提交。
      if (branchSha !== null && !(await this.#isAncestor(repo, branchSha, "refs/heads/develop"))) {
        throw new Error("任务分支还有未合入 develop 的提交，已保留分支和工作树");
      }
      const entry = (await this.#worktrees(repo)).find((item) => resolve(item.path) === owner.worktreePath);
      if (entry) {
        if (entry.branch !== branchRef) throw new Error("任务工作树已切换分支，已保留现场");
        await this.#clean(owner.worktreePath, "任务工作树有未提交或未跟踪的内容，已保留现场");
        await this.#git(repo, ["worktree", "remove", owner.worktreePath]);
      }
      if (branchSha !== null) await this.#git(repo, ["update-ref", "-d", branchRef, branchSha]);
      await rm(location.ownerFile, { force: true });
    });
  }

  async #repo(project: TaskProject): Promise<string> {
    if (!isAbsolute(project.cwd)) throw new Error("项目路径必须是绝对路径");
    const path = await realpath(project.cwd);
    const root = await realpath((await this.#git(path, ["rev-parse", "--show-toplevel"])).text.trim());
    if (path !== root) throw new Error("T3 项目路径必须是 Git 仓库根目录");
    return root;
  }

  #assertProject(project: TaskProject, run: TaskWorktreeRun): void {
    if (project.cwd !== run.projectCwd) throw new Error("T3 项目目录已变化，不能操作原任务分支");
  }

  async #location(repo: string, taskId: string): Promise<{ worktreePath: string; ownerFile: string }> {
    const hash = createHash("sha256").update(repo).digest("hex").slice(0, 16);
    const dir = join(this.#options.dataDir, "tasks", "worktrees", hash);
    await mkdir(dir, { recursive: true });
    const canonical = await realpath(dir);
    return { worktreePath: join(canonical, taskId), ownerFile: join(canonical, `${taskId}.json`) };
  }

  async #readOwner(path: string): Promise<Owner | null> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 16_384) throw new Error("任务工作树记录不正确，需要人工检查");
      return JSON.parse(await readFile(path, "utf8")) as Owner;
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error("任务工作树记录无法读取，需要人工检查");
    }
  }

  #assertOwner(owner: Owner, repo: string, branch: string, path: string): void {
    if (owner?.version !== 1 || owner.repo !== repo || owner.branch !== branch || owner.worktreePath !== path || !SHA.test(owner.baseSha)) {
      throw new Error("任务工作树记录与当前项目不一致，已保留原内容");
    }
  }

  async #verifyRun(repo: string, run: TaskWorktreeRun): Promise<string> {
    const id = run.branch.startsWith("task/") ? run.branch.slice(5) : "";
    if (!TASK_ID.test(id) || !SHA.test(run.baseSha)) throw new Error("任务分支记录不正确");
    const location = await this.#location(repo, id);
    const owner = await this.#readOwner(location.ownerFile);
    if (owner === null) throw new Error("缺少任务工作树记录，不能操作未知分支");
    this.#assertOwner(owner, repo, run.branch, location.worktreePath);
    if (run.worktreePath !== owner.worktreePath || run.baseSha !== owner.baseSha) throw new Error("任务执行记录与工作树不一致");
    await this.#assertWorktree(repo, owner);
    const status = await this.#git(run.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
    if (status.truncated) throw new Error("任务工作树变更过多，请在 T3 中确认未提交或未跟踪的内容后重新检查");
    if (status.text !== "") {
      const counts = { uncommitted: 0, untracked: 0 };
      for (const entry of status.text.split("\0")) {
        if (entry) counts[entry.startsWith("?? ") ? "untracked" : "uncommitted"] += 1;
      }
      throw new TaskDirtyWorktreeError(counts);
    }
    const headSha = await this.#sha(run.worktreePath, "HEAD");
    if (!(await this.#isAncestor(repo, run.baseSha, headSha))) throw new Error("任务分支已重写起点，请人工检查");
    return headSha;
  }

  async #assertWorktree(repo: string, owner: Owner): Promise<void> {
    const info = await lstat(owner.worktreePath);
    if (!info.isDirectory() || await realpath(owner.worktreePath) !== owner.worktreePath) throw new Error("任务工作树路径已变化");
    const entry = (await this.#worktrees(repo)).find((item) => resolve(item.path) === owner.worktreePath);
    if (entry?.branch !== `refs/heads/${owner.branch}`) throw new Error("任务工作树不在预期分支上，已保留现场");
    const commonArgs = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const [repoCommon, taskCommon] = await Promise.all([this.#git(repo, commonArgs), this.#git(owner.worktreePath, commonArgs)]);
    if (await realpath(repoCommon.text.trim()) !== await realpath(taskCommon.text.trim())) throw new Error("任务工作树不属于当前项目");
    if ((await this.#git(owner.worktreePath, ["symbolic-ref", "-q", "HEAD"])).text.trim() !== `refs/heads/${owner.branch}`) {
      throw new Error("任务工作树已切换分支，已保留现场");
    }
  }

  async #worktrees(repo: string): Promise<Worktree[]> {
    const result = await this.#git(repo, ["worktree", "list", "--porcelain", "-z"]);
    if (result.truncated) throw new Error("项目工作树列表过大，不能安全检查 develop 所在位置");
    return result.text.split("\0\0").filter(Boolean).map((block) => {
      const fields = block.split("\0");
      return {
        path: fields.find((field) => field.startsWith("worktree "))?.slice(9) ?? "",
        branch: fields.find((field) => field.startsWith("branch "))?.slice(7) ?? null,
      };
    });
  }

  async #develop(repo: string): Promise<string> {
    if (!(await this.#hasRef(repo, "refs/heads/develop"))) throw new Error("项目缺少本地 develop 分支，请先创建 develop");
    return this.#sha(repo, "refs/heads/develop");
  }

  async #reviewBase(repo: string, taskBase: string, headSha: string): Promise<string> {
    const developRef = "refs/heads/develop";
    if (!(await this.#hasRef(repo, developRef))) return taskBase;
    const common = await this.#git(repo, ["merge-base", developRef, headSha], { allowFailure: true });
    if (common.code === 1) return taskBase;
    const commonSha = common.text.trim();
    if (common.code !== 0 || !SHA.test(commonSha)) throw new Error("无法读取任务对比基线");
    return commonSha === taskBase || !(await this.#isAncestor(repo, taskBase, commonSha)) ? taskBase : commonSha;
  }

  async #sha(repo: string, ref: string): Promise<string> {
    const sha = (await this.#git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).text.trim();
    if (!SHA.test(sha)) throw new Error("Git 提交编号不正确");
    return sha;
  }

  async #hasRef(repo: string, ref: string): Promise<boolean> {
    const result = await this.#git(repo, ["show-ref", "--verify", "--quiet", ref], { allowFailure: true });
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new Error("无法检查 Git 分支");
  }

  async #clean(path: string, message: string): Promise<void> {
    if ((await this.#git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).text !== "") throw new Error(message);
  }

  async #isAncestor(repo: string, base: string, head: string): Promise<boolean> {
    const result = await this.#git(repo, ["merge-base", "--is-ancestor", base, head], { allowFailure: true });
    if (result.code !== 0 && result.code !== 1) throw new Error("无法检查 Git 提交关系，已保留现场");
    return result.code === 0;
  }

  async #safeChanges(repo: string, base: string, head: string): Promise<void> {
    const result = await this.#git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--no-renames", "-z", base, head, "--"]);
    if (result.truncated) throw new Error("任务变更文件过多，请在 T3 中缩小任务范围后重新核对");
    const paths = result.text.split("\0").filter(Boolean);
    if (paths.some(sensitivePath)) throw new Error("任务包含环境配置、凭据或密钥文件变更，请先移除这些变更后重新核对");
  }

  #serialize<T>(repo: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(repo) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.#queues.set(repo, next);
    void next.finally(() => { if (this.#queues.get(repo) === next) this.#queues.delete(repo); }).catch(() => undefined);
    return next;
  }

  #git(cwd: string, args: string[], options: { allowFailure?: boolean; limit?: number; stderr?: boolean; timeoutMs?: number } = {}): Promise<GitResult> {
    return new Promise((accept, reject) => {
      const env: NodeJS.ProcessEnv = { ...(this.#options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
      // 推送不能停在等人输入密码或确认主机上，宁可失败也不要挂住。
      if (options.stderr === true && env.GIT_SSH_COMMAND === undefined) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
      const binary = process.platform === "win32" ? "git" : "/usr/bin/git";
      const child = spawn(binary, ["-c", "core.fsmonitor=false", ...args], { cwd, env, stdio: ["ignore", "pipe", options.stderr === true ? "pipe" : "ignore"] });
      const limit = options.limit ?? COMMAND_LIMIT;
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      let bytes = 0;
      let errorBytes = 0;
      let truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 30_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (bytes + chunk.length > limit) truncated = true;
        if (bytes < limit) chunks.push(chunk.subarray(0, limit - bytes));
        bytes += chunk.length;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (errorBytes < 8192) errors.push(chunk.subarray(0, 8192 - errorBytes));
        errorBytes += chunk.length;
      });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) { reject(new Error(`Git ${args[0] ?? ""} 超时，已保留现场`)); return; }
        if (code !== 0 && options.allowFailure !== true) { reject(new Error(`Git ${args[0] ?? ""} 失败（退出码 ${code ?? "unknown"}），已保留现场`)); return; }
        accept({ text: Buffer.concat(chunks).toString("utf8"), err: Buffer.concat(errors).toString("utf8"), code: code ?? -1, truncated });
      });
    });
  }
}

/** Git 的报错里可能带着含凭据的远端地址，只保留一行并抹掉 `://用户:密码@`。 */
function redact(text: string): string {
  return text.replace(/:\/\/[^/@\s]+@/gu, "://").replace(/\s+/gu, " ").trim();
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function sensitivePath(path: string): boolean {
  return path.split("/").some((part) =>
    /^\.env(?:\.|$)/iu.test(part) ||
    /^(?:\.ssh|\.aws|\.gnupg)$/iu.test(part) ||
    /^\.?(?:secrets?|credentials?|tokens?|access[-_]?token|refresh[-_]?token)(?:\.(?:json|ya?ml|toml|ini|conf))?$/iu.test(part) ||
    /^(?:client[-_]secrets?|service[-_]?account)(?:[._-].*)?\.json$/iu.test(part) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)(?:\.|$)/iu.test(part) ||
    /\.(?:pem|key|p8|p12|pfx|jks|keychain|keychain-db)$/iu.test(part));
}
