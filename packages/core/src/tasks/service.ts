import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TaskActionSchema, TaskCreateSchema, TaskUpdateSchema, type TaskState } from "./schema.js";
import { TaskStore } from "./store.js";
import type {
  DevelopmentTask, TaskActionInput, TaskAutomationPort, TaskBoard, TaskCreateInput,
  TaskGitPort, TaskHttpPort, TaskProject, TaskReview, TaskUpdateInput,
} from "./types.js";

export class TaskError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

class TaskPersistenceError extends Error {}

export interface TaskServiceOptions {
  dataDir: string;
  automation: TaskAutomationPort;
  git: TaskGitPort;
  now?: () => Date;
  id?: () => string;
  onChange?: () => void;
  pollMs?: number;
  /** 测试注入存储故障；生产使用原子文件写入。 */
  store?: Pick<TaskStore, "read" | "write">;
}

const ACTIVE = new Set(["preparing", "running", "review", "merging", "failed"]);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function nextProjectTask(tasks: DevelopmentTask[], projectId: string): DevelopmentTask | null {
  if (tasks.some((task) => task.projectId === projectId && ACTIVE.has(task.status))) return null;
  return tasks.filter((task) => task.projectId === projectId && task.status === "queued")
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** 每次状态与外部操作按顺序持久化。人工确认是唯一能进入 merging 的入口。 */
export class TaskService implements TaskHttpPort {
  readonly #store: Pick<TaskStore, "read" | "write">;
  #state: TaskState | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pollPending = false;
  #stopped = false;
  #connectionError: string | null = null;
  #liveProjects = new Set<string>();

  constructor(private readonly options: TaskServiceOptions) {
    this.#store = options.store ?? new TaskStore(join(options.dataDir, "tasks", "board.json"));
  }

  start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#timer = setInterval(() => this.poke(), this.options.pollMs ?? 5_000);
    this.#timer.unref?.();
    this.poke();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#queue;
  }

  poke(): void {
    if (this.#stopped || this.#pollPending) return;
    this.#pollPending = true;
    void this.tick().catch((error) => { this.#connectionError = message(error); })
      .finally(() => { this.#pollPending = false; });
  }

  /** 暴露单轮给确定性的回归测试；计时器不积压重复轮询。 */
  tick(): Promise<void> {
    return this.#serial(async () => {
      const state = await this.#load();
      if (this.#stopped || !state.tasks.some((task) => task.status !== "done")) return;
      if (!(await this.#refreshProjects())) return;
      for (const project of state.projects) {
        if (this.#stopped || !this.#liveProjects.has(project.id)) continue;
        const active = state.tasks.find((task) => task.projectId === project.id && ACTIVE.has(task.status));
        try {
          if (active) {
            this.#checkProject(project, active);
            if (active.status === "preparing") await this.#dispatch(project, active);
            else if (active.status === "running") await this.#inspect(project, active);
            else if (active.status === "merging") await this.#merge(project, active);
          } else if (project.enabled) {
            const next = nextProjectTask(state.tasks, project.id);
            if (next) {
              next.status = "preparing";
              await this.#save(next);
              await this.#dispatch(project, next);
            }
          }
        } catch (error) {
          if (error instanceof TaskPersistenceError) throw error;
          const task = state.tasks.find((item) => item.projectId === project.id && ACTIVE.has(item.status));
          if (task) await this.#fail(task, error);
        }
      }
    });
  }

  board(): Promise<TaskBoard> {
    return this.#serial(async () => {
      await this.#load();
      await this.#refreshProjects();
      return this.#board();
    });
  }

  create(input: TaskCreateInput): Promise<TaskBoard> {
    return this.#serial(async () => {
      const body = TaskCreateSchema.parse(input);
      const state = await this.#load();
      if (body.projectId) await this.#requireProject(body.projectId);
      const now = this.#now();
      state.tasks.push({
        id: this.options.id?.() ?? randomUUID(), title: body.title,
        description: body.description ?? "", projectId: body.projectId ?? null,
        priority: body.priority ?? 2, status: "queued", createdAt: now, updatedAt: now, run: null,
      });
      await this.#save();
      this.poke();
      return this.#board();
    });
  }

  update(input: TaskUpdateInput): Promise<TaskBoard> {
    return this.#serial(async () => {
      const body = TaskUpdateSchema.parse(input);
      const task = await this.#task(body.id);
      if (task.status !== "queued") throw new TaskError(409, "只有待处理的 TODO 可以修改；已开工任务请在 T3 中核对。");
      if (body.projectId) await this.#requireProject(body.projectId);
      if (body.title !== undefined) task.title = body.title;
      if (body.description !== undefined) task.description = body.description;
      if (body.projectId !== undefined) task.projectId = body.projectId;
      if (body.priority !== undefined) task.priority = body.priority;
      await this.#save(task);
      this.poke();
      return this.#board();
    });
  }

  action(input: TaskActionInput): Promise<TaskBoard> {
    return this.#serial(async () => {
      const body = TaskActionSchema.parse(input);
      await this.#load();
      if (body.action === "project") {
        // 暂停只需本机状态；断连时也必须能阻止恢复连接后继续领取。
        const project = body.enabled ? await this.#requireProject(body.projectId) : this.#state!.projects.find((item) => item.id === body.projectId);
        if (!project) throw new TaskError(404, "T3 项目不存在。");
        // 同一仓库即使在 T3 中重复登记，也只能有一个自动领取入口。
        if (body.enabled && this.#state!.projects.some((item) => item.id !== project.id && item.cwd === project.cwd &&
          (item.enabled || this.#state!.tasks.some((task) => task.projectId === item.id && ACTIVE.has(task.status))))) {
          throw new TaskError(409, "这个仓库已在另一个 T3 项目中自动执行，请先暂停该项目。");
        }
        project.enabled = body.enabled;
        await this.#save();
      } else {
        const task = await this.#task(body.id);
        if (task.projectId === null) throw new TaskError(409, "请先关联 T3 项目。");
        const project = await this.#requireProject(task.projectId);
        this.#checkProject(project, task);
        if (body.action === "approve") {
          if (task.status !== "review" || task.run?.reviewSha !== body.reviewSha) {
            throw new TaskError(409, "核对版本已变化，请重新打开变更后确认。");
          }
          const live = await this.options.automation.inspect(task.run.threadId!);
          if (live.state !== "ready") throw new TaskError(409, "T3 任务仍在处理或已出错，请等待完成后重新核对。");
          // 先写入已批准的 SHA，再执行；崩溃恢复只重试这个已获批准的版本。
          task.status = "merging";
          await this.#save(task);
          try { await this.#merge(project, task); }
          catch (error) { await this.#fail(task, error); throw new TaskError(409, message(error)); }
        } else if (body.action === "reject") {
          if (task.status !== "review" || !task.run?.threadId) throw new TaskError(409, "只有待核对的 TODO 可以退回处理。");
          task.run.pendingFeedback = { commandId: randomUUID(), prompt: this.#feedbackPrompt(body.feedback) };
          task.run.reviewSha = null;
          task.status = "running";
          await this.#save(task);
          try { await this.#feedback(task); }
          catch (error) { await this.#fail(task, error); throw new TaskError(409, message(error)); }
        } else {
          if (task.status !== "failed") throw new TaskError(409, "当前 TODO 不需要重试。");
          if (task.run?.threadUrl && task.run.threadId && !task.run.pendingFeedback) {
            const live = await this.options.automation.inspect(task.run.threadId);
            if (live.state === "failed") {
              task.run.pendingFeedback = { commandId: randomUUID(), prompt: this.#feedbackPrompt("上一次执行中断或失败，请检查原因并继续完成原任务。") };
            }
          }
          task.status = task.run?.threadUrl ? "running" : "preparing";
          task.error = null;
          if (task.run) { task.run.error = null; task.run.reviewSha = null; }
          await this.#save(task);
        }
      }
      this.poke();
      return this.#board();
    });
  }

  review(id: string): Promise<TaskReview> {
    return this.#serial(async () => {
      const task = await this.#task(id);
      if (task.status !== "review" || !task.run || !task.projectId) throw new TaskError(409, "TODO 尚未进入人工核对。");
      const project = await this.#requireProject(task.projectId);
      this.#checkProject(project, task);
      try {
        const result = await this.options.git.review(project, task.run);
        task.run.reviewSha = result.headSha;
        await this.#save(task);
        return { task: structuredClone(task), ...result };
      } catch (error) {
        await this.#fail(task, error);
        throw new TaskError(409, message(error));
      }
    });
  }

  async #dispatch(project: TaskProject, task: DevelopmentTask): Promise<void> {
    if (!task.run) {
      const prepared = await this.options.git.prepare(project, task.id);
      task.run = {
        ...prepared, projectCwd: project.cwd, threadId: randomUUID(), threadUrl: null,
        reviewSha: null, summary: "", error: null,
      };
      await this.#save(task);
    }
    if (this.#stopped) return;
    const started = await this.options.automation.start({
      projectId: project.id, title: task.title, prompt: this.#taskPrompt(task),
      cwd: task.run.worktreePath, branch: task.run.branch, threadId: task.run.threadId!,
    });
    if (started.threadId !== task.run.threadId) throw new Error("T3 返回的会话与已保存的任务会话不一致。");
    task.run.threadUrl = started.threadUrl;
    task.run.error = null;
    task.status = "running";
    await this.#save(task);
  }

  async #inspect(project: TaskProject, task: DevelopmentTask): Promise<void> {
    if (!task.run?.threadId) throw new Error("任务缺少 T3 会话，请人工检查。");
    if (task.run.pendingFeedback) await this.#feedback(task);
    const result = await this.options.automation.inspect(task.run.threadId);
    if (result.state === "failed") throw new Error(result.error || "T3 任务出错，请打开会话处理后重试。");
    if (result.state !== "ready") return;
    const review = await this.options.git.review(project, task.run);
    task.run.summary = result.summary;
    task.run.reviewSha = review.headSha;
    task.run.error = null;
    task.status = "review";
    await this.#save(task);
  }

  async #feedback(task: DevelopmentTask): Promise<void> {
    const run = task.run!;
    const pending = run.pendingFeedback;
    if (!pending || !run.threadId) return;
    await this.options.automation.followup(run.threadId, pending.prompt, pending.commandId);
    delete run.pendingFeedback;
    await this.#save(task);
  }

  async #merge(project: TaskProject, task: DevelopmentTask): Promise<void> {
    if (!task.run?.reviewSha || !task.run.threadId) throw new Error("缺少人工核对版本，不能合并。");
    const live = await this.options.automation.inspect(task.run.threadId);
    if (live.state !== "ready") throw new Error("T3 会话在核对后发生变化，请完成处理并重新核对。");
    await this.options.git.merge(project, task.run, task.run.reviewSha);
    task.status = "done";
    task.error = null;
    task.run.error = null;
    await this.#save(task);
  }

  #taskPrompt(task: DevelopmentTask): string {
    return [
      "这是 U-Brain TODO 队列派发的单个开发任务。", `任务：${task.title}`, task.description,
      `工作目录：${task.run!.worktreePath}`, `任务分支：${task.run!.branch}`,
      "只在这个独立工作树和任务分支完成本任务。先阅读项目规则，保护已有修改。",
      "完成后运行适用检查，并将本任务变更提交到当前任务分支。提交前检查 diff，只提交相关文件，禁止提交 .env、凭证和密钥。",
      "禁止 checkout、修改或合并 develop，禁止 push、部署、删除工作树和分支。人工核对通过后由 U-Brain 合并。",
      "最后说明完成内容、验证结果和未解决事项。遇到需要用户决定的问题请在 T3 会话中询问。",
    ].filter(Boolean).join("\n\n");
  }

  #feedbackPrompt(feedback: string): string {
    return `人工核对未通过，请在原任务工作树和分支继续处理以下反馈。完成检查并提交到该任务分支后，再等待人工核对。禁止合并 develop、push 或部署。\n\n${feedback}`;
  }

  async #refreshProjects(): Promise<boolean> {
    try {
      const projects = await this.options.automation.projects();
      const state = this.#state!;
      const old = new Map(state.projects.map((project) => [project.id, project]));
      this.#liveProjects = new Set(projects.map((project) => project.id));
      const next = projects.map((project) => ({ ...project, enabled: old.get(project.id)?.cwd === project.cwd && old.get(project.id)?.enabled === true }));
      // 消失的项目仍显示历史任务，但停用自动领取。
      for (const previous of state.projects) if (!this.#liveProjects.has(previous.id)) next.push({ ...previous, enabled: false });
      if (JSON.stringify(next) !== JSON.stringify(state.projects)) {
        state.projects = next;
        await this.#save();
      }
      this.#connectionError = null;
      return true;
    } catch (error) {
      if (error instanceof TaskPersistenceError) throw error;
      this.#connectionError = message(error);
      this.#liveProjects.clear();
      return false;
    }
  }

  async #requireProject(id: string): Promise<TaskProject> {
    if (!(await this.#refreshProjects())) throw new TaskError(503, this.#connectionError ?? "T3 连接失败。");
    const project = this.#state!.projects.find((item) => item.id === id);
    if (!project || !this.#liveProjects.has(id)) throw new TaskError(409, "关联的 T3 项目已不存在，请重新选择。");
    return project;
  }

  #checkProject(project: TaskProject, task: DevelopmentTask): void {
    if (task.run && task.run.projectCwd !== project.cwd) throw new TaskError(409, "T3 项目目录已变化，请人工核对原任务工作树。");
  }

  async #task(id: string): Promise<DevelopmentTask> {
    const state = await this.#load();
    const task = state.tasks.find((item) => item.id === id);
    if (!task) throw new TaskError(404, "TODO 不存在。");
    return task;
  }

  async #load(): Promise<TaskState> { return this.#state ??= await this.#store.read(); }
  #now(): string { return (this.options.now?.() ?? new Date()).toISOString(); }
  #board(): TaskBoard { return structuredClone({ projects: this.#state!.projects, tasks: this.#state!.tasks, connectionError: this.#connectionError }); }

  async #save(task?: DevelopmentTask): Promise<void> {
    if (task) task.updatedAt = this.#now();
    try { await this.#store.write(this.#state!); }
    catch {
      // 内存不能领先于磁盘。尤其 merging 已获批准，Git 成功后写 done 失败时
      // 保留磁盘上的 merging，下一轮以同一 SHA 幂等补记完成。
      this.#state = null;
      throw new TaskPersistenceError("TODO 状态保存失败，已停止本轮操作；恢复存储后会从已保存的状态继续。");
    }
    this.options.onChange?.();
  }

  async #fail(task: DevelopmentTask, error: unknown): Promise<void> {
    if (error instanceof TaskPersistenceError) throw error;
    task.status = "failed";
    task.error = message(error);
    if (task.run) task.run.error = message(error);
    else this.#connectionError = message(error);
    await this.#save(task);
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => {
      if (this.#stopped) return Promise.reject(new TaskError(503, "应用正在退出，TODO 操作已停止。"));
      return fn();
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
