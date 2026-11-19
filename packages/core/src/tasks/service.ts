import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { TaskActionSchema, TaskCreateSchema, TaskUpdateSchema, type TaskState } from "./schema.js";
import { TaskStore } from "./store.js";
import type {
  DevelopmentTask, TaskActionInput, TaskAutomationPort, TaskBoard, TaskCreateInput,
  TaskGitPort, TaskHttpPort, TaskNewProject, TaskProject, TaskReview, TaskStatus, TaskUpdateInput,
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
  homeDir?: string;
  /** 按项目 cwd 返回该仓库已锁定的项目决定摘要（< 3KB），供派发时注入。 */
  projectContext?: (cwd: string) => Promise<string | null> | string | null;
  /** 测试注入存储故障；生产使用原子文件写入。 */
  store?: Pick<TaskStore, "read" | "write">;
}

const ACTIVE = new Set<TaskStatus>(["preparing", "planning", "running", "review", "merging", "failed"]);
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const samePath = (a: string, b: string): boolean => a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");

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
      for (const task of state.tasks) {
        if (this.#stopped) return;
        if (task.projectId === null && (task.status === "preparing" || task.status === "planning" || task.status === "running")) {
          try { await this.#advance(null, task); }
          catch (error) { await this.#fail(task, error); }
        }
      }
      for (const project of state.projects) {
        if (this.#stopped || !this.#liveProjects.has(project.id)) continue;
        const active = state.tasks.find((task) => task.projectId === project.id && ACTIVE.has(task.status));
        try {
          if (active) {
            this.#checkProject(project, active);
            await this.#advance(project, active);
          } else if (project.enabled && !this.#projectBusy(project)) {
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
      const projectId = await this.#taskProject(body);
      const now = this.#now();
      state.tasks.push({
        id: this.options.id?.() ?? randomUUID(), title: body.title,
        description: body.description ?? "", projectId: projectId ?? null,
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
      const projectId = await this.#taskProject(body);
      if (body.title !== undefined) task.title = body.title;
      if (body.description !== undefined) task.description = body.description;
      if (projectId !== undefined) task.projectId = projectId;
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
        if (body.action === "start" && task.status !== "queued") throw new TaskError(409, "只有待处理的 TODO 可以开始。");
        if (task.projectId === null && (body.action === "approve" || body.action === "reject")) {
          throw new TaskError(409, "未关联项目的 TODO 不参与代码核对和合并。");
        }
        const project = task.projectId === null ? null : await this.#requireProject(task.projectId);
        if (project) this.#checkProject(project, task);
        else if (!(await this.#refreshProjects())) throw new TaskError(503, this.#connectionError ?? "T3 连接失败。");
        if (body.action === "start") {
          if (project && this.#projectBusy(project)) throw new TaskError(409, "项目已有待完成的 TODO，请先处理该任务。");
          task.manual = true;
          task.status = "preparing";
          await this.#save(task);
          try { await this.#dispatch(project, task); }
          catch (error) { await this.#fail(task, error); }
        } else if (body.action === "approve") {
          if (!project || task.status !== "review" || task.run?.reviewSha !== body.reviewSha || !task.run.threadId) {
            throw new TaskError(409, "核对版本已变化，请重新打开变更后确认。");
          }
          const live = await this.options.automation.inspect(task.run.threadId, task.manual);
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
            const live = await this.options.automation.inspect(task.run.threadId, task.manual);
            if (live.state === "failed") {
              const retry = "上一次执行中断或失败，请检查原因并继续原任务。";
              const prompt = task.manual ? `${retry} 若用户尚未确认需求和计划，只继续只读分析并等待用户确认。` : this.#feedbackPrompt(retry);
              task.run.pendingFeedback = { commandId: randomUUID(), prompt };
            }
          }
          task.status = task.run?.threadUrl ? (task.manual ? "planning" : "running") : "preparing";
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
      if (task.status !== "review" || !task.run || task.run.branch === null || !task.projectId) throw new TaskError(409, "TODO 尚未进入人工核对。");
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

  async #advance(project: TaskProject | null, task: DevelopmentTask): Promise<void> {
    if (task.status === "preparing") await this.#dispatch(project, task);
    else if (task.status === "planning" || task.status === "running") await this.#inspect(project, task);
    else if (project && task.status === "merging") await this.#merge(project, task);
  }

  async #dispatch(project: TaskProject | null, task: DevelopmentTask): Promise<void> {
    if (!task.run) {
      const prepared = project ? await this.options.git.prepare(project, task.id) : { branch: null, worktreePath: null, baseSha: null };
      task.run = {
        ...prepared, projectCwd: project?.cwd ?? this.options.homeDir ?? homedir(), requestId: randomUUID(), threadId: null, threadUrl: null,
        reviewSha: null, summary: "", error: null,
      };
      await this.#save(task);
    }
    if (this.#stopped) return;
    if ((project !== null) !== (task.run.branch !== null)) throw new Error("TODO 工作目录与项目关联不一致，请人工检查。");
    // 旧记录在派发前就存了自定的会话编号，沿用它作派发编号。
    const requestId = task.run.requestId ?? task.run.threadId;
    if (!requestId) throw new Error("任务缺少派发编号，请人工检查。");
    const rawContext = project && this.options.projectContext
      ? await Promise.resolve(this.options.projectContext(project.cwd)).catch(() => null)
      : null;
    const launch = { title: task.title, prompt: this.#taskPrompt(task, rawContext), requestId };
    const started = project && task.run.branch !== null
      ? await this.options.automation.start({ ...launch, projectId: project.id, cwd: task.run.worktreePath, branch: task.run.branch, plan: task.manual })
      : await this.options.automation.start({ ...launch, projectId: null, cwd: task.run.projectCwd, branch: null, plan: true });
    task.run.requestId = requestId;
    task.run.threadId = started.threadId;
    task.run.threadUrl = started.threadUrl;
    task.run.error = null;
    task.status = task.manual ? "planning" : "running";
    await this.#save(task);
  }

  async #inspect(project: TaskProject | null, task: DevelopmentTask): Promise<void> {
    if (!task.run?.threadId) throw new Error("任务缺少 T3 会话，请人工检查。");
    if ((project !== null) !== (task.run.branch !== null)) throw new Error("TODO 工作目录与项目关联不一致，请人工检查。");
    if (task.run.pendingFeedback) await this.#feedback(task);
    const result = await this.options.automation.inspect(task.run.threadId, task.manual);
    if (result.state === "failed") throw new Error(result.error || "T3 任务出错，请打开会话处理后重试。");
    if (result.state !== "ready") {
      if (task.status !== result.state) {
        task.status = result.state;
        await this.#save(task);
      }
      return;
    }
    const review = project && task.run.branch !== null ? await this.options.git.review(project, task.run) : null;
    task.run.summary = result.summary;
    task.run.reviewSha = review?.headSha ?? null;
    task.run.error = null;
    task.status = review ? "review" : "done";
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
    if (!task.run?.reviewSha || !task.run.threadId || task.run.branch === null) throw new Error("缺少人工核对版本，不能合并。");
    const live = await this.options.automation.inspect(task.run.threadId, task.manual);
    if (live.state !== "ready") throw new Error("T3 会话在核对后发生变化，请完成处理并重新核对。");
    await this.options.git.merge(project, task.run, task.run.reviewSha);
    task.status = "done";
    task.error = null;
    task.run.error = null;
    await this.#save(task);
  }

  #taskPrompt(task: DevelopmentTask, rawProjectContext?: string | null): string {
    const trimmedContext = (rawProjectContext ?? "").trim();
    const projectSection =
      trimmedContext === ""
        ? ""
        : `【项目既有口径参考（与仓库当前代码冲突时以代码为准）】\n${
            trimmedContext.length > 3_000 ? `${trimmedContext.slice(0, 3_000)}…` : trimmedContext
          }`;
    const run = task.run!;
    return [
      "这是 U-Brain TODO 派发的单个任务。", `任务：${task.title}`, task.description,
      `工作目录：${run.worktreePath ?? run.projectCwd}`,
      projectSection,
      ...(task.manual ? [
        "先只读了解需求和现状，明确目标、范围和验收标准；在 T3 中向用户确认需求，有歧义先提问，再根据确认结果提出具体计划。即使描述已很完整，也要等用户明确确认需求和计划。确认前不改文件、不跑有副作用的命令、不提交代码。若会话仍处于计划模式，请用户切换到执行模式后再按确认的计划继续。",
      ] : []),
      ...(run.branch !== null ? [
        `任务分支：${run.branch}。只在这个独立工作树和任务分支完成本任务。先阅读项目规则，保护已有修改。`,
        "完成后运行适用检查，并将本任务变更提交到当前任务分支。提交前检查 diff，只提交相关文件，禁止提交 .env、凭证和密钥。",
        "禁止 checkout、修改或合并 develop，禁止 push、部署、删除工作树和分支。人工核对通过后由 U-Brain 合并。",
      ] : ["工作目录是用户主目录，不代表授权访问无关文件。只在用户确认的范围内处理，不自动创建仓库、提交、推送或部署。"]),
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

  /** 解析 TODO 要关联的项目；newProject 时先在 T3 登记，同一文件夹已登记过就直接复用。 */
  async #taskProject(body: { projectId?: string | null | undefined; newProject?: TaskNewProject | undefined }): Promise<string | null | undefined> {
    if (!body.newProject) {
      if (body.projectId) await this.#requireProject(body.projectId);
      return body.projectId;
    }
    if (!(await this.#refreshProjects())) throw new TaskError(503, this.#connectionError ?? "T3 连接失败。");
    const { name, cwd } = body.newProject;
    const live = this.#state!.projects.filter((item) => this.#liveProjects.has(item.id));
    const existing = cwd !== undefined ? live.find((item) => samePath(item.cwd, cwd)) : undefined;
    if (existing) return existing.id;
    let created: Omit<TaskProject, "enabled">;
    try { created = await this.options.automation.createProject({ name, ...(cwd !== undefined ? { cwd } : {}) }); }
    catch (error) { throw new TaskError(502, `T3 新建项目失败：${message(error)}`); }
    await this.#refreshProjects();
    if (!this.#state!.projects.some((item) => item.id === created.id)) {
      this.#state!.projects.push({ ...created, enabled: false });
      this.#liveProjects.add(created.id);
      await this.#save();
    }
    return created.id;
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

  #projectBusy(project: TaskProject): boolean {
    const { tasks, projects } = this.#state!;
    const ids = new Set(projects.filter((item) => samePath(item.cwd, project.cwd)).map((item) => item.id));
    return tasks.some((task) => task.projectId !== null && ids.has(task.projectId) && ACTIVE.has(task.status));
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
