import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { TaskGitPort, TaskProject, TaskReview, TaskRun } from "./types.js";

const DIFF_LIMIT = 128 * 1024;
const COMMAND_LIMIT = 1024 * 1024;
const SHA = /^[a-f0-9]{40,64}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/u;

interface GitResult { text: string; code: number; truncated: boolean }
interface Worktree { path: string; branch: string | null }
interface Owner {
  version: 1;
  repo: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
}

/** 任务只在自己的 worktree 里执行；合并入口只能接收已由人核对的提交。 */
export class TaskGit implements TaskGitPort {
  readonly #options: { dataDir: string; env?: NodeJS.ProcessEnv };
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: { dataDir: string; env?: NodeJS.ProcessEnv }) {
    this.#options = options;
  }

  async prepare(project: TaskProject, taskId: string): Promise<Pick<TaskRun, "branch" | "worktreePath" | "baseSha">> {
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

  async review(project: TaskProject, run: TaskRun): Promise<Omit<TaskReview, "task">> {
    this.#assertProject(project, run);
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      await this.#verifyRun(repo, run);
      const headSha = await this.#sha(run.worktreePath, "HEAD");
      const baseSha = await this.#develop(repo);
      if (baseSha === headSha) throw new Error("任务还没有可核对的提交");
      await this.#ancestor(repo, baseSha, headSha, "develop 已发生分歧，请先在 T3 中处理后重新核对");
      await this.#safeChanges(repo, baseSha, headSha);
      const stat = (await this.#git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--stat", baseSha, headSha, "--"])).text;
      const diff = await this.#git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseSha, headSha, "--"], { limit: DIFF_LIMIT });
      return { headSha, baseSha, stat, diff: diff.text, truncated: diff.truncated };
    });
  }

  async merge(project: TaskProject, run: TaskRun, approvedSha: string): Promise<void> {
    this.#assertProject(project, run);
    if (!SHA.test(approvedSha)) throw new Error("核对提交编号不正确");
    if (run.reviewSha === null) throw new Error("任务尚未核对，请先核对提交后再合并");
    const repo = await this.#repo(project);
    return this.#serialize(repo, async () => {
      await this.#verifyRun(repo, run);
      const headSha = await this.#sha(run.worktreePath, "HEAD");
      if (approvedSha !== headSha || run.reviewSha !== approvedSha) {
        throw new Error("任务提交已变化，请重新核对后再合并");
      }
      const develop = await this.#develop(repo);
      // 崩溃可能发生在 Git 成功后、队列写回前。相同提交可以安全补记完成。
      if (develop === approvedSha) return;
      await this.#ancestor(repo, develop, approvedSha, "develop 已发生分歧，不能快进合并，请先在 T3 中处理后重新核对");
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

  async #repo(project: TaskProject): Promise<string> {
    if (!isAbsolute(project.cwd)) throw new Error("项目路径必须是绝对路径");
    const path = await realpath(project.cwd);
    const root = await realpath((await this.#git(path, ["rev-parse", "--show-toplevel"])).text.trim());
    if (path !== root) throw new Error("T3 项目路径必须是 Git 仓库根目录");
    return root;
  }

  #assertProject(project: TaskProject, run: TaskRun): void {
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

  async #verifyRun(repo: string, run: TaskRun): Promise<void> {
    const id = run.branch.startsWith("task/") ? run.branch.slice(5) : "";
    if (!TASK_ID.test(id) || !SHA.test(run.baseSha)) throw new Error("任务分支记录不正确");
    const location = await this.#location(repo, id);
    const owner = await this.#readOwner(location.ownerFile);
    if (owner === null) throw new Error("缺少任务工作树记录，不能操作未知分支");
    this.#assertOwner(owner, repo, run.branch, location.worktreePath);
    if (run.worktreePath !== owner.worktreePath || run.baseSha !== owner.baseSha) throw new Error("任务执行记录与工作树不一致");
    await this.#assertWorktree(repo, owner);
    await this.#clean(run.worktreePath, "任务工作树有未提交或未跟踪的内容，请在 T3 中提交后重新检查");
    await this.#ancestor(repo, run.baseSha, await this.#sha(run.worktreePath, "HEAD"), "任务分支已重写起点，请人工检查");
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

  async #ancestor(repo: string, base: string, head: string, message: string): Promise<void> {
    const result = await this.#git(repo, ["merge-base", "--is-ancestor", base, head], { allowFailure: true });
    if (result.code !== 0) throw new Error(message);
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

  #git(cwd: string, args: string[], options: { allowFailure?: boolean; limit?: number } = {}): Promise<GitResult> {
    return new Promise((accept, reject) => {
      const env = { ...(this.#options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" };
      const binary = process.platform === "win32" ? "git" : "/usr/bin/git";
      const child = spawn(binary, ["-c", "core.fsmonitor=false", ...args], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
      const limit = options.limit ?? COMMAND_LIMIT;
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        if (bytes + chunk.length > limit) truncated = true;
        if (bytes < limit) chunks.push(chunk.subarray(0, limit - bytes));
        bytes += chunk.length;
      });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) { reject(new Error(`Git ${args[0] ?? ""} 超时，已保留现场`)); return; }
        if (code !== 0 && options.allowFailure !== true) { reject(new Error(`Git ${args[0] ?? ""} 失败（退出码 ${code ?? "unknown"}），已保留现场`)); return; }
        accept({ text: Buffer.concat(chunks).toString("utf8"), code: code ?? -1, truncated });
      });
    });
  }
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
