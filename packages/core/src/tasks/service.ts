import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { TaskActionSchema, TaskCreateSchema, TaskUpdateSchema, type TaskState } from "./schema.js";
import { TaskAlreadyMergedError, TaskBehindDevelopError, TaskDirtyWorktreeError, TaskMergeBlockedError, TaskNoCommitError } from "./git.js";
import { parseTaskImage, TaskImages } from "./images.js";
import type { TaskRequirementClassifier, TaskRequirementKind } from "./classify.js";
import { TaskStore } from "./store.js";
import { TASK_IMAGE_MAX_COUNT } from "./types.js";
import type {
  DevelopmentTask, TaskActionInput, TaskAutomationPort, TaskBoard, TaskCreateInput,
  TaskGitPort, TaskHttpPort, TaskImageData, TaskNewProject, TaskProject, TaskReview, TaskRun, TaskStatus, TaskUpdateInput, TaskWorktreeRun,
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
  /** 手动启动前判定 TODO 是否属于需求型；未注入时交由 T3 会话只读判断。 */
  classifyTask?: TaskRequirementClassifier | undefined;
  /** 测试注入存储故障；生产使用原子文件写入。 */
  store?: Pick<TaskStore, "read" | "write">;
}

/** 尚未结束、需要轮询推进的任务。 */
const ACTIVE = new Set<TaskStatus>(["preparing", "planning", "running", "review", "merging", "failed"]);
const EXECUTING = new Set<TaskStatus>(["preparing", "planning", "running", "merging"]);
/** 同一仓库同时执行的 TODO 上限；待核对、执行后受阻的任务不占名额。 */
export const PROJECT_PARALLEL_LIMIT = 3;
/** 同步 develop 后快进失败（develop 又被其他任务推进）时，最多再同步几次。 */
const SYNC_RETRIES = 2;
const LEGACY_DIRTY_WORKTREE = "任务工作树有未提交或未跟踪的内容，请在 T3 中提交后重新检查";
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const samePath = (a: string, b: string): boolean => a.replace(/\/+$/u, "") === b.replace(/\/+$/u, "");

/** 占用执行名额：执行中，或还没派发成功就失败（多为 T3/模型/Git 配置问题，避免把整个队列连续派发失败）。 */
function occupiesSlot(task: DevelopmentTask): boolean {
  return EXECUTING.has(task.status) || (task.status === "failed" && !task.run?.threadId);
}

export function nextProjectTask(tasks: DevelopmentTask[], projectId: string): DevelopmentTask | null {
  if (tasks.filter((task) => task.projectId === projectId && occupiesSlot(task)).length >= PROJECT_PARALLEL_LIMIT) return null;
  return tasks.filter((task) => task.projectId === projectId && task.status === "queued")
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** 每次状态与外部操作按顺序持久化。人工确认是唯一能进入 merging 的入口。 */
export class TaskService implements TaskHttpPort {
  readonly #store: Pick<TaskStore, "read" | "write">;
  readonly #images: TaskImages;
  #state: TaskState | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pollPending = false;
  #stopped = false;
  #connectionError: string | null = null;
  #liveProjects = new Set<string>();

  constructor(private readonly options: TaskServiceOptions) {
    this.#store = options.store ?? new TaskStore(join(options.dataDir, "tasks", "board.json"));
    this.#images = new TaskImages(join(options.dataDir, "tasks", "images"));
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
        if (task.projectId === null && (task.status === "preparing" || task.status === "planning" || task.status === "running" || task.status === "failed")) {
          try { await this.#advance(null, task); }
          catch (error) { await this.#fail(task, error); }
        }
      }
      for (const project of state.projects) {
        if (this.#stopped || !this.#liveProjects.has(project.id)) continue;
        for (const task of state.tasks.filter((item) => item.projectId === project.id && ACTIVE.has(item.status))) {
          if (this.#stopped) return;
          try {
            this.#checkProject(project, task);
            await this.#advance(project, task);
          } catch (error) { await this.#fail(task, error); }
        }
        // 每个任务有独立的分支和工作树，可并行执行；合并仍逐个快进 develop。
        while (project.enabled && !this.#stopped && !this.#projectBusy(project)) {
          const next = nextProjectTask(state.tasks, project.id);
          if (!next) break;
          next.status = "preparing";
          await this.#save(next);
          try { await this.#dispatch(project, next); }
          catch (error) {
            await this.#fail(next, error);
            break;
          }
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

  create(input: TaskCreateInput, files: readonly File[] = []): Promise<TaskBoard> {
    return this.#serial(async () => {
      const body = TaskCreateSchema.parse(input);
      const state = await this.#load();
      const images = await this.#parseImages(files, 0);
      const projectId = await this.#taskProject(body);
      const now = this.#now();
      const task: DevelopmentTask = {
        id: this.options.id?.() ?? randomUUID(), title: body.title,
        description: body.description ?? "", projectId: projectId ?? null,
        priority: body.priority ?? 2, status: "queued", createdAt: now, updatedAt: now, run: null,
      };
      await this.#saveImages(images, async () => {
        if (images.length) task.images = images.map(({ bytes: _bytes, ...metadata }) => metadata);
        state.tasks.push(task);
        await this.#save();
      });
      this.poke();
      return this.#board();
    });
  }

  update(input: TaskUpdateInput, files: readonly File[] = []): Promise<TaskBoard> {
    return this.#serial(async () => {
      const body = TaskUpdateSchema.parse(input);
      const task = await this.#task(body.id);
      if (task.status !== "queued") throw new TaskError(409, "只有待处理的 TODO 可以修改；已开工任务请在 T3 中核对。");
      const previous = task.images ?? [];
      const keep = body.retainImageIds;
      const retained = keep === undefined ? previous : previous.filter((image) => keep.includes(image.id));
      if (keep !== undefined && retained.length !== keep.length) throw new TaskError(400, "只能保留本任务的图片。");
      const images = await this.#parseImages(files, retained.length);
      const projectId = await this.#taskProject(body);
      await this.#saveImages(images, async () => {
        if (body.title !== undefined) task.title = body.title;
        if (body.description !== undefined) task.description = body.description;
        if (projectId !== undefined) task.projectId = projectId;
        if (body.priority !== undefined) task.priority = body.priority;
        if (keep !== undefined || images.length) task.images = [...retained, ...images.map(({ bytes: _bytes, ...metadata }) => metadata)];
        await this.#save(task);
      });
      await this.#images.remove(previous.filter((image) => !retained.includes(image)));
      this.poke();
      return this.#board();
    });
  }

  image(taskId: string, imageId: string): Promise<TaskImageData> {
    return this.#serial(async () => {
      const task = await this.#task(taskId);
      const image = task.images?.find((item) => item.id === imageId);
      if (!image) throw new TaskError(404, "TODO 图片不存在。");
      return this.#readImage(image);
    });
  }

  async #readImage(image: Omit<TaskImageData, "bytes">): Promise<TaskImageData> {
    try { return await this.#images.read(image); }
    catch { throw new TaskError(404, "TODO 图片不存在或无法读取。"); }
  }

  async #parseImages(files: readonly File[], retained: number): Promise<TaskImageData[]> {
    if (files.length + retained > TASK_IMAGE_MAX_COUNT) throw new TaskError(400, "每个 TODO 最多可添加 4 个附件。");
    const images: TaskImageData[] = [];
    for (const file of files) {
      const image = await parseTaskImage(file);
      if (!image) throw new TaskError(400, "附件不能为空且单个不能超过 10 MB。");
      images.push(image);
    }
    return images;
  }

  async #saveImages(images: TaskImageData[], save: () => Promise<void>): Promise<void> {
    try {
      for (const image of images) await this.#images.write(image);
      await save();
    } catch (error) {
      await this.#images.remove(images);
      throw error;
    }
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
        if (body.action === "complete") {
          if (task.status === "merging") throw new TaskError(409, "TODO 正在合并中，请等待处理结束。");
          if (task.status !== "done") {
            task.completedManually = true;
            await this.#complete(task);
          }
          return this.#board();
        }
        if (body.action === "start" && task.status !== "queued") throw new TaskError(409, "只有待处理的 TODO 可以开始。");
        if (task.projectId === null && (body.action === "approve" || body.action === "reject")) {
          throw new TaskError(409, "未关联项目的 TODO 不参与代码核对和合并。");
        }
        const project = task.projectId === null ? null : await this.#requireProject(task.projectId);
        if (project) this.#checkProject(project, task);
        else if (!(await this.#refreshProjects())) throw new TaskError(503, this.#connectionError ?? "T3 连接失败。");
        if (body.action === "start") {
          if (project && this.#projectBusy(project)) throw new TaskError(409, `项目已有 ${PROJECT_PARALLEL_LIMIT} 个 TODO 在执行，请等其中一个完成或进入核对。`);
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
          task.run.error = null;
          task.error = null;
          task.status = "running";
          await this.#save(task);
          try { await this.#feedback(task); }
          catch (error) { await this.#fail(task, error); throw new TaskError(409, message(error)); }
        } else {
          if (task.status !== "failed") throw new TaskError(409, "当前 TODO 不需要重试。");
          if (project && task.run?.merged && task.run.branch !== null) {
            // 本地 develop 已合并，只补做推送和清理。
            task.status = "merging";
            task.error = null;
            task.run.error = null;
            await this.#save(task);
            try { await this.#publishAndComplete(project, task, task.run); }
            catch (error) { await this.#fail(task, error); throw new TaskError(409, message(error)); }
            return this.#board();
          }
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
        if (task.run.reviewSha !== result.headSha) {
          task.error = null;
          task.run.error = null;
        }
        task.run.reviewSha = result.headSha;
        await this.#save(task);
        return { task: structuredClone(task), ...result };
      } catch (error) {
        if (error instanceof TaskAlreadyMergedError) await this.#finishMerged(project, task);
        else await this.#fail(task, error);
        throw new TaskError(409, message(error));
      }
    });
  }

  async #advance(project: TaskProject | null, task: DevelopmentTask): Promise<void> {
    if (task.status === "failed" || task.status === "review") await this.#resume(project, task);
    else if (task.status === "preparing") await this.#dispatch(project, task);
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
    let requirementKind = task.manual ? task.run.requirementKind : undefined;
    if (task.manual && requirementKind === undefined && this.options.classifyTask) {
      requirementKind = await this.options.classifyTask({
        title: task.title,
        description: task.description,
        hasImages: (task.images?.length ?? 0) > 0,
        projectContext: rawContext,
      }).catch(() => "uncertain" as const);
      task.run.requirementKind = requirementKind;
      await this.#save(task);
      if (this.#stopped) return;
    }
    const images = await Promise.all((task.images ?? []).map((image) => this.#readImage(image)));
    const launch = {
      title: task.title,
      prompt: this.#taskPrompt(task, rawContext, requirementKind),
      requestId,
      ...(images.length ? { images } : {}),
      ...(task.manual && requirementKind ? { requirementKind } : {}),
    };
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
    await this.#reviewReady(project, task, task.run, result.summary);
  }

  async #reviewReady(project: TaskProject | null, task: DevelopmentTask, run: TaskRun, summary: string): Promise<void> {
    let review: Awaited<ReturnType<TaskGitPort["review"]>> | null = null;
    if (project && run.branch !== null) {
      try { review = await this.options.git.review(project, run); }
      catch (error) {
        if (error instanceof TaskAlreadyMergedError) {
          run.summary = summary;
          await this.#finishMerged(project, task);
          return;
        }
        if (!(error instanceof TaskNoCommitError)) throw error;
        // 这一轮停下但还没提交：AI 在等用户在 T3 里确认或回答，按“需求确认”继续等，不报错。
        if (task.status !== "planning") {
          task.status = "planning";
          task.error = null;
          run.error = null;
          await this.#save(task);
        }
        return;
      }
    }
    run.summary = summary;
    run.reviewSha = review?.headSha ?? null;
    run.error = null;
    task.error = null;
    task.status = review ? "review" : "done";
    await this.#save(task);
  }

  /**
   * 标成“需要处理”或“待人工核对”后，用户直接在 T3 里回复让它继续干：会话又跑起来就回到进行中，
   * 不必再点重试；之前核对的版本作废，等这一轮做完重新核对。
   */
  async #resume(project: TaskProject | null, task: DevelopmentTask): Promise<void> {
    // 已合入 develop、只差推送或清理的任务不自动重试，等人处理后点“重试”。
    if (!task.run?.threadId || task.run.pendingFeedback || task.run.merged) return;
    let live: Awaited<ReturnType<TaskAutomationPort["inspect"]>>;
    try { live = await this.options.automation.inspect(task.run.threadId, task.manual); }
    catch { return; }
    if (live.state === "ready" && project && task.run.branch !== null && task.status === "failed" &&
      (task.error ?? task.run.error) === LEGACY_DIRTY_WORKTREE) {
      await this.#reviewReady(project, task, task.run, live.summary);
      return;
    }
    if (live.state === "ready" && project && task.run.branch !== null &&
      await this.options.git.isMerged(project, task.run).catch(() => false)) {
      if (live.summary) task.run.summary = live.summary;
      await this.#finishMerged(project, task);
      return;
    }
    if (live.state !== "planning" && live.state !== "running") return;
    task.status = live.state;
    task.error = null;
    task.run.error = null;
    task.run.reviewSha = null;
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

  /**
   * 确认合并：先把最新 develop 同步进任务分支（并行任务可能已先合入），再快进本地 develop，
   * 然后推送 develop、清理任务分支和工作树，并标记 TODO 已完成。失败时保留任务等人处理。
   */
  async #merge(project: TaskProject, task: DevelopmentTask): Promise<void> {
    const run = task.run;
    if (!run || run.branch === null) throw new Error("缺少任务分支记录，不能合并。");
    if (!run.merged) {
      if (!run.reviewSha || !run.threadId) throw new Error("缺少人工核对版本，不能合并。");
      const live = await this.options.automation.inspect(run.threadId, task.manual);
      if (live.state !== "ready") throw new Error("T3 会话在核对后发生变化，请完成处理并重新核对。");
      if (!(await this.#mergeIntoDevelop(project, task, run))) return;
      // 先记下“已合并”：之后推送失败或崩溃，都只补做后半段，不再重复合并。
      run.merged = true;
      await this.#save(task);
    }
    await this.#publishAndComplete(project, task, run);
  }

  /** 返回 false 表示同步 develop 时有冲突，已交回 T3 处理，不继续合并。 */
  async #mergeIntoDevelop(project: TaskProject, task: DevelopmentTask, run: TaskWorktreeRun): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.options.git.merge(project, run, run.reviewSha!);
        return true;
      } catch (error) {
        if (!(error instanceof TaskBehindDevelopError)) throw error;
        if (attempt >= SYNC_RETRIES) throw new TaskMergeBlockedError("本地 develop 刚刚发生变化，请重新核对后再确认合并。");
        const result = await this.options.git.syncDevelop(project, run, run.reviewSha!);
        if (result === "conflict") {
          await this.#handBack(task, run, "确认合并时，本地 develop 已有其他任务合入的新提交，自动合入有冲突，已撤销。用户授权你在当前工作树执行 git merge develop（不要 rebase），解决冲突并提交合并结果，然后运行适用检查，如有问题修复并提交到任务分支。");
          return false;
        }
        if (result === "merged") {
          // develop 已合入任务分支：以合并后的提交为准继续快进，不再要求人工重新核对。
          run.reviewSha = (await this.options.git.review(project, run)).headSha;
          await this.#save(task);
        }
      }
    }
  }

  async #publishAndComplete(project: TaskProject, task: DevelopmentTask, run: TaskWorktreeRun): Promise<void> {
    await this.options.git.publish(project, run);
    await this.options.git.cleanup(project, run);
    await this.#complete(task);
  }

  /** 任务提交已在本地 develop（外部合并）：同样推送、清理并标记完成。 */
  async #finishMerged(project: TaskProject, task: DevelopmentTask): Promise<void> {
    const run = task.run;
    if (!run || run.branch === null) { await this.#complete(task); return; }
    try {
      run.merged = true;
      task.status = "merging";
      await this.#save(task);
      await this.#publishAndComplete(project, task, run);
    } catch (error) { await this.#fail(task, error); }
  }

  /** 交回原 T3 会话处理；完成后重新进入人工核对。 */
  async #handBack(task: DevelopmentTask, run: TaskWorktreeRun, prompt: string): Promise<void> {
    run.pendingFeedback = {
      commandId: randomUUID(),
      prompt: `${prompt}完成后说明处理内容和验证结果，等待人工重新核对。禁止修改 develop、push 或部署。`,
    };
    run.reviewSha = null;
    run.error = null;
    task.error = null;
    task.status = "running";
    await this.#save(task);
    await this.#feedback(task);
  }

  async #complete(task: DevelopmentTask): Promise<void> {
    task.status = "done";
    task.error = null;
    if (task.run) task.run.error = null;
    await this.#save(task);
  }

  #taskPrompt(task: DevelopmentTask, rawProjectContext?: string | null, requirementKind?: TaskRequirementKind): string {
    const trimmedContext = (rawProjectContext ?? "").trim();
    const projectSection =
      trimmedContext === ""
        ? ""
        : `【项目既有口径参考（与仓库当前代码冲突时以代码为准）】\n${
            trimmedContext.length > 3_000 ? `${trimmedContext.slice(0, 3_000)}…` : trimmedContext
          }`;
    const run = task.run!;
    const manualGuidance = !task.manual
      ? []
      : requirementKind === "requirement"
        ? [
            "本任务已判定为需求型 TODO，请先调用并遵循 `grill-me`（由 T3 按当前 Provider 触发）。先只读查证能从项目中确认的事实，再围绕范围、关键取舍和验收标准按依赖顺序逐项讨论，每次只问一个问题，给出推荐答案并等待回复，需求确认后再拟定实施计划。",
            "即使描述已很完整，也要等用户明确确认需求和计划。确认前不改文件、不跑有副作用的命令、不提交代码。若会话仍处于计划模式，请用户切换到执行模式后再按确认的计划继续。",
          ]
        : requirementKind === "other"
          ? [
              "本任务为非需求型 TODO（如缺陷修复、重构、测试、文档或排查），无需调用需求访谈流程；请先只读了解项目现状，明确目标、范围与验收标准，再提出具体实施计划。",
              "即使描述已很完整，也要等用户明确确认计划。确认前不改文件、不跑有副作用的命令、不提交代码。若会话仍处于计划模式，请用户切换到执行模式后再按确认的计划继续。",
            ]
          : [
              "先只读结合任务标题、说明、附件和项目现状判断任务类型。新增功能、改变既有产品行为或业务规则属于需求型；仅恢复预期行为的缺陷修复、纯重构、测试、文档维护或排查等属于其他任务。无法判断时，先向用户澄清目标，不要凭关键词决定。",
              "仅对需求型 TODO，先遵循 `grill-me` 讨论方式（若会话已挂载 `grill-me` Skill 可先调用，否则只读查看 `~/.agents/skills/grill-me/SKILL.md`；仍无法加载时告知用户并按同样方式讨论）：能从项目中确认的先自行查证，其余按依赖顺序讨论范围、关键取舍和验收标准，每次只问一个问题，给出推荐答案并等待回复。其他任务按常规流程明确目标、范围和验收标准，再提出计划。",
              "即使描述已很完整，也要等用户明确确认需求和计划。确认前不改文件、不跑有副作用的命令、不提交代码。若会话仍处于计划模式，请用户切换到执行模式后再按确认的计划继续。",
            ];
    return [
      "这是 U-Brain TODO 派发的单个任务。", `任务：${task.title}`, task.description,
      `工作目录：${run.worktreePath ?? run.projectCwd}`,
      projectSection,
      ...manualGuidance,
      ...(run.branch !== null ? [
        `任务分支：${run.branch}。只在这个独立工作树和任务分支完成本任务。先阅读项目规则，保护已有修改。`,
        "完成后运行适用检查，并将本任务变更提交到当前任务分支。提交前检查 diff，只提交相关文件，禁止提交 .env、凭证和密钥。",
        "不要切换到或修改 develop。仅在用户明确要求时，才可将本地 develop 同步到当前任务分支。禁止 push、部署、删除工作树和分支。人工核对通过后由 U-Brain 合并到 develop。",
      ] : ["工作目录是用户主目录，不代表授权访问无关文件。只在用户确认的范围内处理，不自动创建仓库、提交、推送或部署。"]),
      "最后说明完成内容、验证结果和未解决事项。遇到需要用户决定的问题请在 T3 会话中询问。",
    ].filter(Boolean).join("\n\n");
  }

  #feedbackPrompt(feedback: string): string {
    return `人工核对未通过，请在原任务工作树和分支继续处理以下反馈。完成检查并提交到该任务分支后，再等待人工核对。禁止合并到 develop、push 或部署。\n\n${feedback}`;
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
    return tasks.filter((task) => task.projectId !== null && ids.has(task.projectId) && occupiesSlot(task)).length >= PROJECT_PARALLEL_LIMIT;
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
    if (task) {
      if (task.status !== "failed") delete task.worktreeBlock;
      task.updatedAt = this.#now();
    }
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
    task.status = task.status === "merging" && error instanceof TaskMergeBlockedError ? "review" : "failed";
    if (error instanceof TaskDirtyWorktreeError) task.worktreeBlock = error.counts;
    else delete task.worktreeBlock;
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
