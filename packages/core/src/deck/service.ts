import { join } from "node:path";

import { ulid, type LlmProvider } from "@you-brain/protocol";

import { createLlmBackend } from "../llm/factory.js";
import { CLI_PROVIDERS, isCliProvider, locateRunnableCli, type CliProvider } from "../llm/cli/locate.js";
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
  readonly #locks = new Map<string, Promise<void>>();
  readonly #cliEnv: NodeJS.ProcessEnv | undefined;
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

  async listJobs(): Promise<DeckJobView[]> {
    return [...this.#jobs.values()].map((job) => ({ ...job.view }));
  }

  /** 发送一条消息：先落用户轮，再跑主控决策并执行。 */
  async send(text: string, conversationId: string | null): Promise<DeckConversation> {
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
      return Promise.resolve();
    });
    const decision = await this.#decide(conversation);
    await this.#applyDecision(conversation, decision);
    return conversation;
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
    return runMasterDecision({ backend, system, user });
  }

  async #applyDecision(
    conversation: DeckConversation,
    decision: DeckDecision,
  ): Promise<void> {
    if (decision.kind === "answer") {
      await this.#withConv(conversation.id, () => {
        this.#appendTurn(conversation, "assistant", decision.text);
        return this.#persist(conversation);
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
      await this.#withConv(conversation.id, () => {
        this.#appendTurn(
          conversation,
          "event",
          `已登记周期任务「${task.title}」（${describeSchedule(task.schedule)}，执行者 ${describeExecutor(task.executor)}）`,
        );
        return this.#persist(conversation);
      });
      return;
    }
    // dispatch
    const jobId = ulid();
    const view: DeckJobView = {
      id: jobId,
      conversationId: conversation.id,
      title: decision.title,
      executor: decision.executor,
      status: "running",
      startedAt: this.#iso(),
    };
    await this.#withConv(conversation.id, () => {
      this.#appendTurn(
        conversation,
        "event",
        `已派活「${decision.title}」→ ${describeExecutor(decision.executor)}（运行中）`,
      );
      return this.#persist(conversation);
    });
    const promise = this.#executeJob(conversation.id, jobId, decision.title, decision.executor, decision.prompt);
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

  async executors(): Promise<DeckExecutorView[]> {
    const views: DeckExecutorView[] = [];
    for (const capability of this.#capabilities) {
      views.push({
        kind: "capability",
        id: capability.id,
        title: capability.title,
        available: true,
        detail: capability.hint,
      });
    }
    for (const provider of CLI_PROVIDERS) {
      if (this.#options.probeExecutors === false) {
        views.push({
          kind: "cli-agent",
          id: provider,
          title: `本机 agent ${provider}`,
          available: false,
          detail: "未探测",
        });
        continue;
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
      views.push({ kind: "cli-agent", id: provider, title: `本机 agent ${provider}`, available, detail });
    }
    const selection = this.#options.llmSelection();
    const preset = LLM_PRESETS[selection.provider];
    views.push({
      kind: "model",
      id: selection.provider,
      title: `模型 ${selection.provider}`,
      available: true,
      detail:
        preset.kind === "cli"
          ? "当前模型配置是订阅 CLI（补全模式）"
          : `当前配置的模型后端（${selection.model || "默认模型"}）`,
    });
    for (const app of GUI_APPS) {
      if (this.#options.probeExecutors === false) {
        views.push({
          kind: "gui-app",
          id: app.id,
          title: app.displayName,
          available: false,
          detail: "未探测",
        });
        continue;
      }
      const status = await guiAppStatus(app);
      views.push({
        kind: "gui-app",
        id: app.id,
        title: app.displayName,
        available: status.available,
        detail: status.detail,
      });
    }
    return views;
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

  /** 保存会话 + 上传会话原文 + 发变更通知。上传失败不阻塞本地保存。 */
  async #persist(conversation: DeckConversation): Promise<void> {
    await this.store.saveConversation(conversation);
    if (this.#options.driveAvailable()) {
      try {
        await uploadDeckSession(this.#options.upload, conversation, this.#options.displayName);
      } catch {
        // Drive 不在或上传失败：本地照常，稍后的对话更新会再试。
      }
    }
    this.#options.emitChange();
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
