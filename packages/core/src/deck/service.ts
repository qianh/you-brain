import { platform } from "node:os";
import { join } from "node:path";

import { ulid, type LlmProvider } from "@you-brain/protocol";

import { createLlmBackend } from "../llm/factory.js";
import { CLI_PROVIDERS, isCliProvider, locateCliBinary, locateRunnableCli, type CliProvider } from "../llm/cli/locate.js";
import { LLM_PRESETS } from "../llm/presets.js";
import type { LlmBackend } from "../llm/types.js";
import type { UploadableSession } from "../upload/types.js";
import {
  deckCapabilities,
  type DeckCapability,
  type DeckCapabilityPort,
} from "./capabilities.js";
import { runCliAgent, DEFAULT_AGENT_TIMEOUT_MS, type RunCliAgentOptions } from "./cli-agent.js";
import type { DeckDecision } from "./decision.js";
import {
  GUI_APPS,
  dispatchToGuiApp,
  guiAppById,
  accessibilityGranted,
  appRunning,
  guiAppStatus,
  recoverGuiAppReplies,
} from "./gui-bridge.js";
import { buildContextPack, buildDecisionSystem, buildDecisionUser, executorCatalogText, runMasterDecision } from "./master.js";
import { DeckStore } from "./store.js";
import { uploadDeckSession } from "./session-sync.js";
import { describeExecutor, describeSchedule, taskDueMs } from "./tasks.js";
import type {
  DeckConfig,
  DeckConversation,
  DeckJobView,
  DeckTask,
  DeckTaskInput,
  DeckTurn,
  ExecutorRef,
} from "./types.js";

export interface DeckServiceOptions {
  dataDir: string;
  /** 会话原文里的 device 字段（=本机 displayName，提炼回填按它过滤）。 */
  displayName: string;
  homeDir: string;
  timeZone: string;
  capabilities: DeckCapabilityPort;
  upload(session: UploadableSession): Promise<unknown>;
  driveAvailable(): boolean;
  llmSelection(): { provider: LlmProvider; model: string; baseUrl: string };
  /** CLI 子进程的查找与运行环境（daemon 传它的 #env；缺省用 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** API 类执行者读密钥（daemon 传钥匙串读取）。 */
  getApiKey?: (provider: LlmProvider) => string | null | undefined | Promise<string | null | undefined>;
  /** 变更通知（SSE），web 端据此刷新指挥台。 */
  emitChange(): void;
  /** 主控回答的流式增量（SSE delta），界面逐字上屏。缺省 = 不流式。 */
  emitDeckDelta?: (conversationId: string, text: string) => void;
  clock?: { now(): Date; nowMs(): number };
  /** 测试注入 CLI agent 执行。 */
  runAgent?: (options: RunCliAgentOptions) => Promise<string>;
  /** 测试注入主控后端（缺省用本机 CLI）。 */
  createMasterBackend?: () => Promise<LlmBackend>;
  /** 测试注入模型执行者后端。 */
  createModelBackend?: () => Promise<LlmBackend>;
  /** false 时跳过 CLI 探测（测试用；探测会 spawn 每个 CLI 的 --version）。 */
  probeExecutors?: boolean;
}

export interface DeckExecutorView {
  kind: string;
  id: string;
  title: string;
  available: boolean;
  detail: string;
}

const RESULT_TEXT_CAP = 20_000;
/** 执行者目录缓存多久算旧:旧了仍立即返回,同时后台刷新(装/卸 CLI 后最多这么久才反映)。 */
const EXECUTORS_TTL_MS = 300_000;
/** 启动后等这么久再预热探测,避开启动高峰。 */
const EXECUTORS_WARM_DELAY_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class DeckService {
  readonly store: DeckStore;
  readonly #options: DeckServiceOptions;
  readonly #capabilities: DeckCapability[];
  #stopped = false;
  readonly #runningTasks = new Set<string>();
  readonly #jobs = new Map<string, { view: DeckJobView; promise: Promise<void> }>();
  readonly #taskRuns = new Set<Promise<void>>();
  readonly #processRuns = new Set<Promise<void>>();
  readonly #deltaEmitAt = new Map<string, number>();
  /** 每个会话一条上传链：落盘不等待 Drive，但同一会话的上传顺序不乱。 */
  readonly #uploads = new Map<string, Promise<void>>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #cliEnv: NodeJS.ProcessEnv | undefined;
  #executorsCache: { at: number; views: DeckExecutorView[] } | null = null;
  #executorsInFlight: Promise<void> | null = null;
  #backendCache: { key: string; backend: LlmBackend } | null = null;
  #defaultProvider: CliProvider | null = null;

  constructor(options: DeckServiceOptions) {
    this.#options = options;
    this.store = new DeckStore(join(options.dataDir, "deck"));
    this.#capabilities = deckCapabilities(options.capabilities);
    // GUI 环境（launchd）的 PATH 没有用户的 ~/.local/bin，会让同名旧版 CLI
    // （如 ~/.bun/bin 里的老 claude）先命中；deck 的子进程把它前置。
    if (options.env !== undefined) {
      const userBin = join(options.homeDir, ".local", "bin");
      // 无条件前置并去掉后面的同名目录：GUI 环境的 PATH 里 ~/.bun/bin 等可能
      // 排在 ~/.local/bin 之前，同名旧版 CLI 会先命中。
      const parts = (options.env.PATH ?? "")
        .split(":")
        .filter((p) => p !== "" && p !== userBin);
      this.#cliEnv = { ...options.env, PATH: [userBin, ...parts].join(":") };
    } else {
      this.#cliEnv = undefined;
    }
  }

  stop(): void {
    this.#stopped = true;
  }

  /** 等所有后台派活结束（测试与关停用）。 */
  async settled(): Promise<void> {
    await Promise.all([
      ...[...this.#jobs.values()].map((job) => job.promise),
      ...this.#taskRuns,
      ...this.#processRuns,
      ...[...this.#uploads.values()],
    ]);
  }

  // ------------------------------------------------------------------
  // 对话
  // ------------------------------------------------------------------

  async listConversations(): Promise<DeckConversation[]> {
    return this.store.listConversations();
  }

  async getConversation(id: string): Promise<DeckConversation | null> {
    return this.store.getConversation(id);
  }

  /** 删除一条会话。运行中的主控/派活产出会因重读不到会话而丢弃。 */
  async deleteConversation(id: string): Promise<boolean> {
    return this.#withConv(id, () => this.store.deleteConversation(id));
  }

  async listJobs(): Promise<DeckJobView[]> {
    return [...this.#jobs.values()].map((job) => ({ ...job.view }));
  }

  /**
   * 发送一条消息：用户轮落盘并广播后就返回，主控决策与执行转后台
   * （界面立刻显示这条消息，主控产出经 SSE 推送）。done 等整轮结束。
   */
  async beginSend(text: string, conversationId: string | null): Promise<DeckConversation> {
    const conversation = await this.#appendUserTurn(text, conversationId);
    const run = this.#process(conversation).catch(() => undefined);
    this.#processRuns.add(run);
    void run.finally(() => this.#processRuns.delete(run));
    return conversation;
  }

  /** beginSend 的阻塞版：等主控决策与执行全部落地（服务层测试用）。 */
  async send(text: string, conversationId: string | null): Promise<DeckConversation> {
    const conversation = await this.#appendUserTurn(text, conversationId);
    await this.#process(conversation);
    return (await this.store.getConversation(conversation.id)) ?? conversation;
  }

  /** 落用户轮（含落盘与变更通知），返回会话。 */
  async #appendUserTurn(text: string, conversationId: string | null): Promise<DeckConversation> {
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("消息不能为空");
    if (this.#stopped) throw new Error("指挥台已停止");
    const existing =
      conversationId !== null ? await this.store.getConversation(conversationId) : null;
    const conversation = existing ?? this.#newConversation();
    await this.#withConv(conversation.id, () => {
      this.#appendTurn(conversation, "user", trimmed);
      if (conversation.taskId === undefined && existing === null) {
        conversation.title = deriveTitle(trimmed);
      }
      return this.#persist(conversation);
    });
    return conversation;
  }

  /** 跑主控决策并执行；失败写进会话（event 轮），不静默吞掉。 */
  async #process(conversation: DeckConversation): Promise<void> {
    const id = conversation.id;
    try {
      const decision = await this.#decide(conversation);
      await this.#applyDecision(id, decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#withConv(id, async () => {
        const fresh = await this.store.getConversation(id);
        if (fresh === null) return;
        this.#appendTurn(fresh, "event", `【主控 · 失败】${message}`);
        await this.#persist(fresh);
      });
    }
  }

  /** 250ms 节流的回答增量（SSE）。最终轮落盘时整段刷新会覆盖它。 */
  #emitDelta(conversationId: string, text: string): void {
    const emit = this.#options.emitDeckDelta;
    if (!emit) return;
    const now = this.#options.clock?.nowMs() ?? Date.now();
    if (now - (this.#deltaEmitAt.get(conversationId) ?? 0) < 250) return;
    this.#deltaEmitAt.set(conversationId, now);
    emit(conversationId, text);
  }

  #newConversation(): DeckConversation {
    const now = this.#iso();
    return {
      id: ulid(),
      title: "新的对话",
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
  }

  async #decide(conversation: DeckConversation): Promise<DeckDecision> {
    const backend = await this.#masterBackend();
    const [catalogRows, contextPack] = await Promise.all([
      this.#catalogRows(),
      this.#contextPack(),
    ]);
    const system = buildDecisionSystem({
      executors: executorCatalogText(catalogRows),
      now: this.#iso(),
      timeZone: this.#options.timeZone,
    });
    const user = buildDecisionUser({
      contextPack,
      history: conversation.turns,
      message: conversation.turns[conversation.turns.length - 1]?.text ?? "",
    });
    return runMasterDecision({
      backend,
      system,
      user,
      ...(this.#options.emitDeckDelta === undefined
        ? {}
        : { onDisplay: (text: string) => this.#emitDelta(conversation.id, text) }),
    });
  }

  /**
   * 执行决策。每条分支都在会话锁内重读 store 再追加——决策期间用户可能
   * 又发了消息，直接用旧对象落盘会把那些轮次覆盖掉。
   */
  async #applyDecision(conversationId: string, decision: DeckDecision): Promise<void> {
    if (decision.kind === "answer") {
      await this.#withConv(conversationId, async () => {
        const conversation = await this.store.getConversation(conversationId);
        if (conversation === null) return;
        this.#appendTurn(conversation, "assistant", decision.text);
        await this.#persist(conversation);
      });
      return;
    }
    if (decision.kind === "schedule") {
      const task = await this.#createTask({
        title: decision.title,
        prompt: decision.prompt,
        executor: decision.executor,
        schedule: decision.schedule,
      });
      await this.#withConv(conversationId, async () => {
        const conversation = await this.store.getConversation(conversationId);
        if (conversation === null) return;
        this.#appendTurn(
          conversation,
          "event",
          `已登记周期任务「${task.title}」（${describeSchedule(task.schedule)}，执行者 ${describeExecutor(task.executor)}）`,
        );
        await this.#persist(conversation);
      });
      return;
    }
    // dispatch
    const jobId = ulid();
    const view: DeckJobView = {
      id: jobId,
      conversationId,
      title: decision.title,
      executor: decision.executor,
      status: "running",
      startedAt: this.#iso(),
    };
    await this.#withConv(conversationId, async () => {
      const conversation = await this.store.getConversation(conversationId);
      if (conversation === null) return;
      this.#appendTurn(
        conversation,
        "event",
        `已派活「${decision.title}」→ ${describeExecutor(decision.executor)}（运行中）`,
      );
      await this.#persist(conversation);
    });
    const promise = this.#executeJob(conversationId, jobId, decision.title, decision.executor, decision.prompt);
    this.#jobs.set(jobId, { view, promise: promise.catch(() => undefined) });
  }

  // ------------------------------------------------------------------
  // 派活执行
  // ------------------------------------------------------------------

  #executeJob(
    conversationId: string,
    jobId: string,
    title: string,
    executor: ExecutorRef,
    prompt: string,
  ): Promise<void> {
    const run = (async () => {
      const job = this.#jobs.get(jobId);
      try {
        const text = await this.#runExecutor(executor, prompt, jobId);
        if (job) job.view.status = "ok";
        const conversation = await this.store.getConversation(conversationId);
        if (conversation !== null) {
          await this.#withConv(conversationId, () => {
            this.#appendTurn(conversation, "assistant", `【${title} · 结果】\n\n${clip(text, RESULT_TEXT_CAP)}`);
            return this.#persist(conversation);
          });
        }
      } catch (error) {
        if (job) {
          job.view.status = "error";
          job.view.error = error instanceof Error ? error.message : String(error);
        }
        const conversation = await this.store.getConversation(conversationId);
        if (conversation !== null) {
          await this.#withConv(conversationId, () => {
            this.#appendTurn(
              conversation,
              "event",
              `【${title} · 失败】${error instanceof Error ? error.message : String(error)}`,
            );
            return this.#persist(conversation);
          });
        }
      }
    })();
    return run;
  }

  async #runExecutor(executor: ExecutorRef, prompt: string, jobId: string): Promise<string> {
    switch (executor.kind) {
      case "cli-agent": {
        if (!isCliProvider(executor.id)) {
          throw new Error(`未知本机 agent：${executor.id}`);
        }
        const workdir = join(this.#options.dataDir, "deck", "agent-work", jobId);
        const runner = this.#options.runAgent ?? runCliAgent;
        return runner({
          provider: executor.id,
          workdir,
          prompt,
          system: `你的工作目录是 ${workdir}。除非指令另有说明，所有文件操作都在这个目录里进行。`,
          ...(this.#options.homeDir !== undefined ? { homeDir: this.#options.homeDir } : {}),
          ...(this.#cliEnv !== undefined ? { env: this.#cliEnv } : {}),
          timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
        });
      }
      case "model": {
        const backend = await this.#modelBackend();
        return backend.complete({
          system:
            "你是被派活的执行者。直接完成指令给出的任务，输出结果正文本身（不要复述任务、不要寒暄）。产出若是长文档就给完整文档。",
          user: prompt,
        });
      }
      case "capability": {
        const capability = this.#capabilities.find((item) => item.id === executor.id);
        if (!capability) throw new Error(`未知能力：${executor.id}`);
        return capability.run(prompt);
      }
      case "gui-app": {
        const app = guiAppById(executor.id);
        if (!app) throw new Error(`未知 GUI App：${executor.id}`);
        const sent = await dispatchToGuiApp(app, prompt);
        if (!app.recoverable) {
          return `已把任务投递进 ${app.displayName}。该 App 的会话落盘格式暂未接入自动回收，回复请在 ${app.displayName} 里查看，稍后会由采集进入你的数字资产。`;
        }
        // 回收：投递后轮询本地转录（20s / 60s / 180s 三次）。
        for (const delayMs of [20_000, 60_000, 180_000]) {
          await sleep(delayMs);
          if (this.#stopped) break;
          const replies = await recoverGuiAppReplies(app, sent.sentAtMs, this.#options.homeDir);
          if (replies.length > 0) {
            return `【来自 ${app.displayName} 的回复】\n\n${replies.join("\n\n---\n\n")}`;
          }
        }
        return `已把任务投递进 ${app.displayName}。三次回收（约 5 分钟内）没有等到新回复；任务可能仍在执行，回复稍后会由 Grok Bot 采集适配器进入你的数字资产。`;
      }
      default:
        throw new Error(`未知执行者类型：${(executor as { kind: string }).kind}`);
    }
  }

  // ------------------------------------------------------------------
  // 周期任务
  // ------------------------------------------------------------------

  async listTasks(): Promise<DeckTask[]> {
    return this.store.listTasks();
  }

  async getConfig(): Promise<DeckConfig> {
    return this.store.readConfig();
  }

  /** 更新主控配置；空串 = 恢复自动。改完立刻失效已缓存的主控后端。 */
  async writeConfig(
    patch: { masterProvider?: string | undefined; masterModel?: string | undefined },
  ): Promise<DeckConfig> {
    const config = await this.store.readConfig();
    if (patch.masterProvider !== undefined) {
      const provider = patch.masterProvider.trim();
      if (provider === "" || !isCliProvider(provider)) delete config.masterProvider;
      else config.masterProvider = provider;
    }
    if (patch.masterModel !== undefined) {
      const model = patch.masterModel.trim();
      if (model === "") delete config.masterModel;
      else config.masterModel = model;
    }
    await this.store.writeConfig(config);
    this.#backendCache = null;
    return config;
  }

  async createTask(input: DeckTaskInput): Promise<DeckTask> {
    return this.#createTask(input);
  }

  async #createTask(input: DeckTaskInput): Promise<DeckTask> {
    const tasks = await this.store.listTasks();
    const task: DeckTask = {
      id: ulid(),
      title: input.title,
      prompt: input.prompt,
      executor: input.executor,
      schedule: input.schedule,
      enabled: input.enabled ?? true,
      createdAt: this.#iso(),
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
    };
    await this.store.saveTasks([...tasks, task]);
    return task;
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<DeckTask, "title" | "prompt" | "enabled" | "schedule" | "executor">>,
  ): Promise<DeckTask | null> {
    const tasks = await this.store.listTasks();
    const task = tasks.find((item) => item.id === id);
    if (!task) return null;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.prompt !== undefined) task.prompt = patch.prompt;
    if (patch.enabled !== undefined) task.enabled = patch.enabled;
    if (patch.schedule !== undefined) task.schedule = patch.schedule;
    if (patch.executor !== undefined) task.executor = patch.executor;
    await this.store.saveTasks(tasks);
    return task;
  }

  async deleteTask(id: string): Promise<boolean> {
    const tasks = await this.store.listTasks();
    const next = tasks.filter((task) => task.id !== id);
    if (next.length === tasks.length) return false;
    await this.store.saveTasks(next);
    return true;
  }

  /** 手动跑一次（阻塞到执行结束）。 */
  async runTaskNow(taskId: string): Promise<DeckTask | null> {
    const tasks = await this.store.listTasks();
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return null;
    await this.#runTask(task);
    return task;
  }

  /** 手动跑一次（后台执行，立即返回；结果写进任务会话）。 */
  async startTask(taskId: string): Promise<DeckTask | null> {
    const tasks = await this.store.listTasks();
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return null;
    const run = this.#runTask(task).catch(() => undefined);
    this.#taskRuns.add(run);
    void run.finally(() => this.#taskRuns.delete(run));
    return task;
  }

  /** daemon tick 挂载点：每分钟看一次有没有到期的周期任务。执行是后台的，不阻塞 tick。 */
  async tick(nowMs: number): Promise<void> {
    if (this.#stopped) return;
    const tasks = await this.store.listTasks();
    for (const task of tasks) {
      if (!task.enabled || this.#stopped) continue;
      if (taskDueMs(task, nowMs, this.#options.timeZone) === null) continue;
      // 后台跑；同一任务在跑时 #runTask 直接跳过，不会双发。
      const run = this.#runTask(task).catch(() => undefined);
      this.#taskRuns.add(run);
      void run.finally(() => this.#taskRuns.delete(run));
    }
  }

  async #runTask(task: DeckTask): Promise<void> {
    if (this.#runningTasks.has(task.id)) return;
    this.#runningTasks.add(task.id);
    try {
      await this.#runTaskInner(task);
    } finally {
      this.#runningTasks.delete(task.id);
    }
  }

  async #runTaskInner(task: DeckTask): Promise<void> {
    const conversationId = `task-${task.id}`;
    let conversation = await this.store.getConversation(conversationId);
    if (conversation === null) {
      conversation = {
        id: conversationId,
        title: `任务：${task.title}`,
        createdAt: this.#iso(),
        updatedAt: this.#iso(),
        taskId: task.id,
        turns: [],
      };
    }
    // 先落盘本轮任务的指令，executeJob 才能把结果写回同一份会话。
    await this.#withConv(conversationId, () => {
      this.#appendTurn(
        conversation!,
        "user",
        `【周期任务 · ${describeSchedule(task.schedule)}】\n\n${task.prompt}`,
      );
      return this.#persist(conversation!);
    });
    const jobId = ulid();
    const job: DeckJobView = {
      id: jobId,
      conversationId,
      title: task.title,
      executor: task.executor,
      status: "running",
      startedAt: this.#iso(),
    };
    const promise = this.#executeJob(conversationId, jobId, task.title, task.executor, task.prompt).then(
      () => undefined,
      () => undefined,
    );
    this.#jobs.set(jobId, { view: job, promise });
    await promise;
    task.lastRunAt = this.#iso();
    task.lastStatus = job.status === "running" ? "ok" : job.status === "ok" ? "ok" : "error";
    task.lastError = job.error ?? null;
    const tasks = await this.store.listTasks();
    const stored = tasks.find((item) => item.id === task.id);
    if (stored) {
      stored.lastRunAt = task.lastRunAt;
      stored.lastStatus = task.lastStatus;
      stored.lastError = task.lastError;
    }
    await this.store.saveTasks(tasks);
  }

  // ------------------------------------------------------------------
  // 执行者目录与主控
  // ------------------------------------------------------------------

  /**
   * 执行者目录(本机 CLI agent / GUI App)。做法对齐主流 AI 应用:
   * 1. 守护进程启动后在后台预热(warmExecutors),不等用户打开页面;
   * 2. 读取永远走缓存,过期了先返回旧值、后台刷新(stale-while-revalidate);
   * 3. 冷启动时先给毫秒级的快速结果(CLI 只看文件在不在、App 只看进程在不在),
   *    要起进程的完整验证(`--version`、辅助功能权限)放后台,结果变了再通知界面。
   */
  async executors(): Promise<DeckExecutorView[]> {
    if (this.#options.probeExecutors === false) return this.#probeExecutors("none");
    const cache = this.#executorsCache;
    if (cache) {
      if (Date.now() - cache.at >= EXECUTORS_TTL_MS) void this.#refreshExecutors();
      return cache.views;
    }
    const quick = await this.#probeExecutors("quick");
    this.#executorsCache = { at: 0, views: quick };
    void this.#refreshExecutors();
    return quick;
  }

  /** 守护进程启动后调用:稍等一下避开启动高峰,再在后台完成完整探测。 */
  warmExecutors(): void {
    if (this.#options.probeExecutors === false) return;
    const timer = setTimeout(() => void this.#refreshExecutors(), EXECUTORS_WARM_DELAY_MS);
    timer.unref?.();
  }

  #refreshExecutors(): Promise<void> {
    if (this.#executorsInFlight) return this.#executorsInFlight;
    this.#executorsInFlight = this.#probeExecutors("full")
      .then((views) => {
        const changed = JSON.stringify(views) !== JSON.stringify(this.#executorsCache?.views);
        this.#executorsCache = { at: Date.now(), views };
        if (changed) this.#options.emitChange();
      })
      .catch(() => undefined)
      .finally(() => {
        this.#executorsInFlight = null;
      });
    return this.#executorsInFlight;
  }

  /** none: 不探测;quick: 只看文件/进程在不在(毫秒);full: 真正运行 --version、检查权限(秒级)。 */
  async #probeExecutors(mode: "none" | "quick" | "full"): Promise<DeckExecutorView[]> {
    const capabilities: DeckExecutorView[] = this.#capabilities.map((capability) => ({
      kind: "capability",
      id: capability.id,
      title: capability.title,
      available: true,
      detail: capability.hint,
    }));
    const clis = await Promise.all(
      CLI_PROVIDERS.map(async (provider): Promise<DeckExecutorView> => {
        const title = `本机 agent ${provider}`;
        if (mode === "none") return { kind: "cli-agent", id: provider, title, available: false, detail: "未探测" };
        if (mode === "quick") {
          const bin = locateCliBinary({
            provider,
            ...(this.#options.homeDir !== undefined ? { homeDir: this.#options.homeDir } : {}),
            ...(this.#cliEnv !== undefined ? { env: this.#cliEnv } : {}),
          });
          return {
            kind: "cli-agent",
            id: provider,
            title,
            available: bin !== null,
            detail: bin !== null ? `已找到（${bin}；后台验证中）` : "未安装",
          };
        }
        let available = false;
        let detail = "未安装";
        try {
          const located = await locateRunnableCli({
            provider,
            ...(this.#options.homeDir !== undefined ? { homeDir: this.#options.homeDir } : {}),
            ...(this.#cliEnv !== undefined ? { env: this.#cliEnv } : {}),
          });
          available = located.bin !== null;
          const skipped = located.unusable
            .map((failure) => `${failure.path}: ${failure.detail}`)
            .join("; ");
          const pathHead = (this.#options.env?.PATH ?? "")
            .split(":")
            .slice(0, 5)
            .join(" | ");
          if (located.bin !== null) {
            detail = `就绪（${located.bin}；PATH=${pathHead}${skipped === "" ? "" : `；跳过 ${skipped}`}）`;
          } else {
            detail = skipped === "" ? "未安装或未登录" : `未就绪（${skipped}；PATH=${pathHead}）`;
          }
        } catch {
          available = false;
        }
        return { kind: "cli-agent", id: provider, title, available, detail };
      }),
    );
    const selection = this.#options.llmSelection();
    const preset = LLM_PRESETS[selection.provider];
    const model: DeckExecutorView = {
      kind: "model",
      id: selection.provider,
      title: `模型 ${selection.provider}`,
      available: true,
      detail:
        preset.kind === "cli"
          ? "当前模型配置是订阅 CLI（补全模式）"
          : `当前配置的模型后端（${selection.model || "默认模型"}）`,
    };
    let accessibility: Promise<boolean> | undefined;
    const sharedAccessibility = (): Promise<boolean> => (accessibility ??= accessibilityGranted());
    const apps = await Promise.all(
      GUI_APPS.map(async (app): Promise<DeckExecutorView> => {
        if (mode === "none") {
          return { kind: "gui-app", id: app.id, title: app.displayName, available: false, detail: "未探测" };
        }
        if (mode === "quick") {
          const running = platform() === "darwin" && (await appRunning(app));
          return {
            kind: "gui-app",
            id: app.id,
            title: app.displayName,
            available: running,
            detail: running ? "App 运行中（后台确认权限）" : "App 未运行",
          };
        }
        const status = await guiAppStatus(app, sharedAccessibility);
        return {
          kind: "gui-app",
          id: app.id,
          title: app.displayName,
          available: status.available,
          detail: status.detail,
        };
      }),
    );
    return [...capabilities, ...clis, model, ...apps];
  }

  async #catalogRows(): Promise<string[]> {
    const rows: string[] = [];
    for (const capability of this.#capabilities) {
      rows.push(`capability:${capability.id} —— ${capability.title}（${capability.hint}）`);
    }
    try {
      for (const view of await this.executors()) {
        if (view.kind === "capability") continue;
        rows.push(
          `${view.kind}:${view.id} —— ${view.title}（${view.available ? "可用" : `不可用：${view.detail}`}）`,
        );
      }
    } catch {
      // 探测失败时 capability 目录仍然可用。
    }
    return rows;
  }

  async #contextPack(): Promise<string> {
    const sections: Array<{ title: string; body: string }> = [];
    const trySection = async (title: string, run: () => Promise<string>): Promise<void> => {
      try {
        sections.push({ title, body: await run() });
      } catch {
        // 单个小节失败不阻塞决策。
      }
    };
    await Promise.all([
      trySection("今日视图", () => this.#options.capabilities.today()),
      trySection("活跃话题", () => this.#options.capabilities.activeTopics()),
    ]);
    try {
      const tasks = await this.store.listTasks();
      if (tasks.length > 0) {
        sections.push({
          title: "已登记的周期任务",
          body: tasks
            .map(
              (task) =>
                `- ${task.title}（${describeSchedule(task.schedule)}，执行者 ${describeExecutor(task.executor)}，${task.enabled ? "启用" : "停用"}）`,
            )
            .join("\n"),
        });
      }
    } catch {
      // 忽略。
    }
    return buildContextPack(sections);
  }

  async #masterBackend(): Promise<LlmBackend> {
    if (this.#options.createMasterBackend) return this.#options.createMasterBackend();
    const [deckConfig, shared] = [await this.store.readConfig(), this.#options.llmSelection()];
    let provider: CliProvider | null = null;
    const override = deckConfig.masterProvider?.trim() ?? "";
    if (override !== "" && isCliProvider(override)) provider = override;
    else if (isCliProvider(shared.provider)) provider = shared.provider;
    else provider = this.#defaultProvider ?? (this.#defaultProvider = await this.#detectDefaultProvider());
    if (provider === null) {
      throw new Error("没有可用的本机 CLI 作为主控；请先安装并登录任一 AI CLI（claude / codex / grok / gemini / opencode）");
    }
    const model = deckConfig.masterModel?.trim() ?? "";
    const key = `${provider}:${model}`;
    if (this.#backendCache?.key === key) return this.#backendCache.backend;
    const backend = await createLlmBackend({
      config: { provider, model, baseUrl: "" },
      getApiKey: () => null,
      dataDir: this.#options.dataDir,
      homeDir: this.#options.homeDir,
      ...(this.#cliEnv !== undefined ? { env: this.#cliEnv } : {}),
      timeoutMs: 180_000,
    });
    this.#backendCache = { key, backend };
    return backend;
  }

  async #modelBackend(): Promise<LlmBackend> {
    if (this.#options.createModelBackend) return this.#options.createModelBackend();
    const shared = this.#options.llmSelection();
    const key = `model:${shared.provider}:${shared.model}`;
    if (this.#backendCache?.key === key) return this.#backendCache.backend;
    const backend = await createLlmBackend({
      config: shared,
      getApiKey: (provider) => this.#options.getApiKey?.(provider) ?? null,
      dataDir: this.#options.dataDir,
      homeDir: this.#options.homeDir,
      ...(this.#cliEnv !== undefined ? { env: this.#cliEnv } : {}),
      timeoutMs: 300_000,
    });
    this.#backendCache = { key, backend };
    return backend;
  }

  async #detectDefaultProvider(): Promise<CliProvider | null> {
    if (this.#options.probeExecutors === false) return null;
    for (const provider of CLI_PROVIDERS) {
      try {
        const bin = await locateRunnableCli({
          provider,
          ...(this.#options.homeDir !== undefined ? { homeDir: this.#options.homeDir } : {}),
          ...(this.#cliEnv !== undefined ? { env: this.#cliEnv } : {}),
        });
        if (bin.bin !== null) return provider;
      } catch {
        continue;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // 落库
  // ------------------------------------------------------------------

  #appendTurn(conversation: DeckConversation, role: DeckTurn["role"], text: string): void {
    const now = this.#iso();
    conversation.turns.push({ id: ulid(), role, text, at: now });
    conversation.updatedAt = now;
  }

  /**
   * 保存会话 + 发变更通知（立刻，界面马上刷新），会话原文上传排进该会话的
   * 后台链：Drive 慢不拖住发送，同一会话的上传顺序仍有保证。
   */
  async #persist(conversation: DeckConversation): Promise<void> {
    await this.store.saveConversation(conversation);
    this.#options.emitChange();
    const id = conversation.id;
    const previous = this.#uploads.get(id) ?? Promise.resolve();
    const run = previous
      .then(() =>
        this.#options.driveAvailable()
          ? uploadDeckSession(this.#options.upload, conversation, this.#options.displayName)
          : undefined,
      )
      .catch(() => {
        // Drive 不在或上传失败：本地照常，稍后的对话更新会再试。
      });
    this.#uploads.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  async #withConv<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.#locks.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  #iso(): string {
    return (this.#options.clock?.now() ?? new Date()).toISOString();
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.split("\n").find((line) => line.trim() !== "") ?? "新的对话";
  return firstLine.trim().slice(0, 24) || "新的对话";
}

function clip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n\n…（结果过长已截断，完整内容见会话原文）`;
}
