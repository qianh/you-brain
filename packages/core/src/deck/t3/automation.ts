import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

import { isTaskImageAttachment, type TaskAutomationPort, type TaskImageData, type TaskRequirementKind } from "../../tasks/types.js";
import { normalizeT3Url } from "./index.js";

/**
 * T3 0.1.9 起编排的 HTTP 写接口已移除，项目与任务会话全部走 T3 对外的 MCP 接口（`/mcp`）。
 * 凭据由本机 t3 CLI 签发一次性配对码，再经 T3 的 MCP OAuth 换取；不读取或修改 T3 数据库。
 */
const MCP_PROTOCOL = "2025-06-18";
const CLIENT_LABEL = "U-Brain TODO";
const REDIRECT_URI = "http://127.0.0.1/u-brain-todo";
/** 任务会话的权限沿用用户在 T3 的选择（可能是 full-access），凭据上限必须不低于它。 */
const CLIENT_ACCESS = "full-access";
const REFRESH_BEFORE_MS = 24 * 60 * 60 * 1000;
const PROJECTS_CACHE_TTL_MS = 15_000;
const CAPABILITIES_CACHE_TTL_MS = 60_000;
const ANTIGRAVITY_INSTANCE_ID = "antigravity";
/** 读尾部消息时覆盖的条目数；一轮里助手消息之间夹着工具调用等条目。 */
const TAIL_ITEMS = 60;
export const MASTER_AGENT_PREAMBLE_START = "<!-- u-brain-master-agent -->";
export const MASTER_AGENT_PREAMBLE_END = "<!-- /u-brain-master-agent -->";

export function stripMasterAgentPreamble(text: string): string {
  return text.replace(/^<!-- u-brain-master-agent -->[\s\S]*?<!-- \/u-brain-master-agent -->\s*/u, "");
}

export interface T3ThreadMessage {
  position: number;
  role: "user" | "assistant";
  text: string;
  runId: string | null;
}

export interface T3ThreadConversation {
  threadId: string;
  state: "running" | "waiting" | "ready" | "failed";
  rawStatus: string;
  threadUrl: string | null;
  itemCount: number;
  activity?: string | null;
  messages: T3ThreadMessage[];
}

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
const LIVE_STATUSES = new Set(["idle", "preparing", "queued", "starting", "running", "waiting"]);
const STOPPED_STATUSES = new Set(["interrupted", "cancelled", "rolled_back"]);

interface ModelSelection { instanceId: string; model: string; options?: unknown }
interface T3Project { id: string; title: string; workspaceRoot: string; defaultModelSelection?: unknown; deletedAt?: string | null }
interface T3ThreadSummary { threadId: string; title: string; providerInstanceId: string; model: string; runtimeMode: string }
interface T3ThreadState {
  threadId: string;
  status: string;
  activeRunId: string | null;
  latestRunId: string | null;
  pendingRequestCount: number;
  archived: boolean;
  interactionMode?: "plan" | "default";
  worktreePath: string | null;
  itemCount: number;
}
interface T3Item { position: number; type: string; runId: string | null; text: string | null; textTruncated: boolean }
interface T3ThreadRead { thread: T3ThreadState; items: T3Item[] }

export interface T3AutomationOptions {
  getUrl: () => Promise<string>;
  /** 测试或自定义本机 T3 实例可注入 MCP 访问令牌；默认经本机 t3 CLI 配对换取，仅留内存。 */
  getToken?: () => Promise<string>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** 测试用，替代 t3 CLI。stdout 可能包含配对码，调用方不得记录。 */
  runCli?: (args: string[]) => Promise<string>;
}

export class T3AutomationError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "UNAVAILABLE" | "INVALID_RESPONSE" | "INVALID_INPUT" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "T3AutomationError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function model(value: unknown): value is ModelSelection {
  return object(value) && text(value.instanceId) && text(value.model);
}

type LaunchMode = "auto-accept-edits" | "auto" | "full-access";

/** 为主控轻量化编排构造低推理耗时选项；保留原实例与模型。antigravity 走 thought_level，其余走 effort / reasoningEffort。 */
function withLowEffortSelection(selection: ModelSelection): ModelSelection {
  const existing = Array.isArray(selection.options)
    ? selection.options.filter(
        (item): item is { id: string; value: unknown } =>
          object(item) && typeof item.id === "string",
      )
    : [];
  if (selection.instanceId === ANTIGRAVITY_INSTANCE_ID) {
    if (existing.some((item) => item.id === "thought_level")) {
      return { instanceId: selection.instanceId, model: selection.model, options: existing };
    }
    return {
      instanceId: selection.instanceId,
      model: selection.model,
      options: [...existing, { id: "thought_level", value: "low" }],
    };
  }
  const filtered = existing.filter((item) => item.id !== "effort" && item.id !== "reasoningEffort");
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    options: [
      ...filtered,
      { id: "effort", value: "low" },
      { id: "reasoningEffort", value: "low" },
    ],
  };
}

/** 当目标 provider 不支持请求的 runtimeMode（如 antigravity 不支持 auto）时，在 maxMode 范围内映射到兼容模式。 */
export function resolveProviderRuntimeMode(
  requested: LaunchMode,
  supported: readonly string[] | null,
  maxMode?: RuntimeMode,
): LaunchMode {
  if (!supported || supported.length === 0 || supported.includes(requested)) return requested;
  if (requested === "auto") {
    if (maxMode === "full-access" && supported.includes("full-access")) return "full-access";
    if (supported.includes("auto-accept-edits")) return "auto-accept-edits";
  }
  if (requested === "full-access") {
    if (supported.includes("auto")) return "auto";
    if (supported.includes("auto-accept-edits")) return "auto-accept-edits";
  }
  return requested;
}

const NATIVE_GRILL_ME_TRIGGERS: Record<string, string> = {
  codex: "/skill:grill-me",
  antigravity: "/grill-me",
  claudeAgent: "/grill-me",
};

const UNSUPPORTED_GRILL_ME_FALLBACK =
  "补充执行约束：当前会话所选模型或环境未确认支持原生 `/grill-me` 或 `/skill:grill-me` 命令。请先尝试只读查看 `~/.agents/skills/grill-me/SKILL.md` 并严格遵循；若无法读取该文件，请告知用户，并按相同方式执行：能从项目中查证的先自行只读确认，其余按决策树依赖顺序逐项讨论范围、关键取舍和验收标准，每次只问一个问题，给出推荐答案并等待回复。";

const ANTIGRAVITY_UNCERTAIN_HINT =
  "补充提示：若只读确认或向用户澄清后属于需求型 TODO，可提醒用户在 T3 中直接发送 `/grill-me` 进入内置需求访谈，或由你直接按 `~/.agents/skills/grill-me/SKILL.md` 逐题提问并给出推荐答案。";

function normalizeProviderDriverKind(instanceId: string): string | null {
  const lower = instanceId.trim().toLowerCase();
  if (lower === "codex" || lower === "antigravity" || lower === "cursor" || lower === "grok") return lower;
  if (lower === "claude" || lower === "claudeagent" || lower === "claude-agent") return "claudeAgent";
  return null;
}

/** 按 T3 Provider 的 driverKind 返回原生触发 grill-me 的首行指令；未确认原生支持时返回 null。 */
export function resolveProviderGrillMeTrigger(driverKind: string | null): string | null {
  return driverKind ? (NATIVE_GRILL_ME_TRIGGERS[driverKind] ?? null) : null;
}

/** 按任务阶段、前置分类结果和目标 Provider 拼接发往 T3 的首条消息；原生命令必须位于消息第 0 个字符位置。 */
export function formatTaskLaunchMessage(input: {
  prompt: string;
  plan?: boolean | undefined;
  requirementKind?: TaskRequirementKind | undefined;
  driverKind: string | null;
  launchReference?: string | null;
}): string {
  const base = `${input.launchReference ?? ""}${input.prompt}`;
  if (!input.plan) return base;
  if (input.requirementKind === "requirement") {
    const trigger = resolveProviderGrillMeTrigger(input.driverKind);
    if (trigger !== null) return `${trigger}\n\n${base}`;
    return `${base}\n\n${UNSUPPORTED_GRILL_ME_FALLBACK}`;
  }
  if (input.requirementKind === "uncertain" && input.driverKind === "antigravity") {
    return `${base}\n\n${ANTIGRAVITY_UNCERTAIN_HINT}`;
  }
  return base;
}

/** 兼容旧格式（首行即派发编号）与新格式（首行原生触发指令后紧跟派发编号）。 */
export function hasLaunchReference(messageText: string | null | undefined, launchReference: string): boolean {
  if (!messageText) return false;
  if (messageText.startsWith(launchReference)) return true;
  const firstBreak = messageText.indexOf("\n");
  if (firstBreak === -1) return false;
  const firstLine = messageText.slice(0, firstBreak).trim();
  if (firstLine !== "/skill:grill-me" && firstLine !== "/grill-me") return false;
  const rest = messageText.slice(firstBreak).replace(/^\r?\n+/u, "");
  return rest.startsWith(launchReference);
}

function runtimeMode(value: unknown): RuntimeMode | undefined {
  return value === "approval-required" || value === "auto-accept-edits" || value === "auto" || value === "full-access" ? value : undefined;
}

function isProject(value: unknown): value is T3Project {
  return object(value) && text(value.id) && typeof value.title === "string" && text(value.workspaceRoot);
}

function isThreadSummary(value: unknown): value is T3ThreadSummary {
  return object(value) && text(value.threadId) && typeof value.title === "string" &&
    typeof value.providerInstanceId === "string" && typeof value.model === "string" && typeof value.runtimeMode === "string";
}

function isThreadState(value: unknown): value is T3ThreadState {
  return object(value) && text(value.threadId) && typeof value.status === "string" &&
    (value.activeRunId === null || typeof value.activeRunId === "string") &&
    (value.latestRunId === null || typeof value.latestRunId === "string") &&
    typeof value.pendingRequestCount === "number" && typeof value.archived === "boolean" &&
    (value.worktreePath === null || typeof value.worktreePath === "string") && typeof value.itemCount === "number";
}

export interface T3ThreadBrief {
  threadId: string;
  title: string;
  status: string;
  latestRunId: string | null;
  snoozed: boolean;
  /** T3 给的网页链接（可在手机上打开）；没有时为 null。 */
  link: string | null;
}

function isThreadBrief(value: unknown): value is { threadId: string; title: string; status: string; latestRunId: string | null; parentThreadId: string | null; snoozed?: boolean; link?: unknown } {
  return object(value) && text(value.threadId) && typeof value.title === "string" && typeof value.status === "string" &&
    (value.latestRunId === null || typeof value.latestRunId === "string") &&
    (value.parentThreadId === null || value.parentThreadId === undefined || typeof value.parentThreadId === "string");
}

function isItem(value: unknown): value is T3Item {
  return object(value) && typeof value.position === "number" && typeof value.type === "string" &&
    (value.runId === null || typeof value.runId === "string") && (value.text === null || typeof value.text === "string") &&
    typeof value.textTruncated === "boolean";
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** 不将认证错误原文返回界面：上游错误和 CLI stdout 都可能含凭据。 */
function invalidResponse(): never {
  throw new T3AutomationError("INVALID_RESPONSE", "T3 接口返回格式不兼容，请检查 T3 版本。当前适配 T3 0.1.9。");
}

function unauthorized(): never {
  throw new T3AutomationError("AUTH_REQUIRED", "T3 未授权。请确认该地址对应本机 t3 CLI 的服务；自定义 T3 实例需提供该实例的授权。");
}

export class T3Automation implements TaskAutomationPort {
  readonly #options: T3AutomationOptions;
  #credential: { token: string; label: string; expiresAt: number } | null = null;
  #issuing: Promise<string> | null = null;
  #staleCleaned = false;
  #session: { url: string; token: string; id: string | null } | null = null;
  #opening: Promise<string | null> | null = null;
  #environments = new Map<string, string>();
  #projectsCache: { expiresAt: number; projects: T3Project[] } | null = null;
  #capabilitiesCache: { expiresAt: number; runtimeModes: Map<string, string[]>; driverKinds: Map<string, string> } | null = null;
  #threadItemCounts = new Map<string, number>();
  #rpcId = 0;

  constructor(options: T3AutomationOptions) { this.#options = options; }

  async projects(): Promise<Array<{ id: string; name: string; cwd: string }>> {
    return (await this.#projects(true)).map((project) => ({ id: project.id, name: project.title, cwd: project.workspaceRoot }));
  }

  /** 有 cwd 时登记本机已有文件夹（不新建目录）；没有时由 T3 按名称新建一个带首次提交的 Git 仓库。 */
  async createProject(input: Parameters<TaskAutomationPort["createProject"]>[0]): Promise<{ id: string; name: string; cwd: string }> {
    const name = input.name.trim();
    if (name === "" || (input.cwd !== undefined && !isAbsolute(input.cwd))) {
      throw new T3AutomationError("INVALID_INPUT", "新项目需要名称；指定文件夹时必须是绝对路径。");
    }
    const created = await this.#call("t3_project_create", {
      title: name,
      ...(input.cwd !== undefined ? { workspaceRoot: input.cwd, createWorkspaceRootIfMissing: false } : {}),
    }, 60_000);
    if (!isProject(created)) invalidResponse();
    this.#projectsCache = null;
    return { id: created.id, name: created.title, cwd: created.workspaceRoot };
  }

  async start(input: Parameters<TaskAutomationPort["start"]>[0]): Promise<{ threadId: string; threadUrl: string }> {
    if (!isAbsolute(input.cwd) || !input.requestId || input.prompt.trim() === "") {
      throw new T3AutomationError("INVALID_INPUT", "任务必须有工作目录、派发编号和任务说明。");
    }
    const url = await this.#url();
    let projects = await this.#projects();
    let project = input.projectId === null
      ? await this.#directoryProject(input.cwd, projects)
      : projects.find((item) => item.id === input.projectId);
    if (!project && input.projectId !== null) {
      projects = await this.#projects(true);
      project = projects.find((item) => item.id === input.projectId);
    }
    if (!project) throw new T3AutomationError("INVALID_INPUT", "T3 中已找不到这个项目，请重新选择项目。");

    const launchReference = input.branch === null ? `U-Brain TODO 派发编号：${input.requestId}\n\n` : null;
    const recovered = await this.#launched(project.id, input.title, input.branch === null ? null : input.cwd, launchReference);
    if (recovered) return { threadId: recovered, threadUrl: await this.#threadUrl(url, recovered) };

    const history = await this.#threads(project.id);
    const latest = history.find((thread) => text(thread.providerInstanceId) && text(thread.model));
    const selection = model(project.defaultModelSelection) ? project.defaultModelSelection
      : latest ? { instanceId: latest.providerInstanceId, model: latest.model } : undefined;
    if (!selection && !input.plan) throw new T3AutomationError("INVALID_INPUT", "请先在 T3 中为这个项目选择模型或创建一次会话，再启动 TODO。");
    const mode = runtimeMode(history.find((thread) => runtimeMode(thread.runtimeMode))?.runtimeMode) ?? (input.branch === null ? "approval-required" : "auto");

    const attachments = [];
    for (const image of input.images ?? []) attachments.push(await this.#uploadImage(url, image));
    const driverKind =
      input.plan && (input.requirementKind === "requirement" || input.requirementKind === "uncertain")
        ? await this.#providerDriverKind(selection?.instanceId)
        : null;
    const message = formatTaskLaunchMessage({
      prompt: input.prompt,
      plan: input.plan,
      requirementKind: input.requirementKind,
      driverKind,
      launchReference,
    });
    const launched = await this.#call("t3_thread_launch", {
      projectId: project.id, title: input.title, message,
      ...(attachments.length ? { attachments } : {}),
      ...(selection ? { modelSelection: selection } : {}), runtimeMode: mode, interactionMode: input.plan ? "plan" : "default",
      workspaceStrategy: input.branch === null ? { type: "root" } : { type: "existing_worktree", worktreePath: input.cwd, branch: input.branch },
      clientRequestId: `u-brain-todo-start-${input.requestId}`,
    }, 60_000);
    if (!object(launched) || !text(launched.threadId)) invalidResponse();
    return { threadId: launched.threadId, threadUrl: await this.#threadUrl(url, launched.threadId) };
  }

  /**
   * 跨设备派活：在项目根目录开普通会话。
   * 模型优先用显式 modelSelection，其次项目默认，最后该项目最近一次会话；不走 worktree / plan。
   */
  async launchThread(input: {
    projectId: string;
    title: string;
    prompt: string;
    requestId: string;
    runtimeMode: LaunchMode;
    maxMode?: RuntimeMode;
    modelSelection?: ModelSelection;
    fastOrchestrator?: boolean;
  }): Promise<{ threadId: string; threadUrl: string }> {
    const url = await this.#url();
    let project = (await this.#projects()).find((item) => item.id === input.projectId);
    if (!project) {
      project = (await this.#projects(true)).find((item) => item.id === input.projectId);
    }
    if (!project) throw new T3AutomationError("INVALID_INPUT", "T3 中已找不到这个项目，请重新选择项目。");
    let selection = model(input.modelSelection) ? input.modelSelection
      : model(project.defaultModelSelection) ? project.defaultModelSelection : undefined;
    if (!selection) {
      const history = await this.#threads(project.id);
      const latest = history.find((thread) => text(thread.providerInstanceId) && text(thread.model));
      if (latest) selection = { instanceId: latest.providerInstanceId, model: latest.model };
    }
    if (!selection) throw new T3AutomationError("INVALID_INPUT", "请先在 T3 中为这个项目选择模型或创建一次会话");
    const supportedModes = await this.#providerRuntimeModes(selection.instanceId);
    const effectiveMode = resolveProviderRuntimeMode(input.runtimeMode, supportedModes, input.maxMode);
    const launchArgs = (selectedModel: ModelSelection, mode: LaunchMode, keySuffix = "") => ({
      projectId: project.id, title: input.title, message: input.prompt, modelSelection: selectedModel,
      runtimeMode: mode, interactionMode: "default",
      workspaceStrategy: { type: "root" },
      clientRequestId: `u-brain-dispatch-${input.requestId}${keySuffix}`,
    });
    const fallbackMode: LaunchMode | null =
      effectiveMode === "auto" && selection.instanceId === ANTIGRAVITY_INSTANCE_ID
        ? (input.maxMode === "full-access" ? "full-access" : "auto-accept-edits")
        : null;
    const primarySelection = input.fastOrchestrator ? withLowEffortSelection(selection) : selection;
    const attempts: Array<{ model: ModelSelection; mode: LaunchMode; suffix: string }> = [
      { model: primarySelection, mode: effectiveMode, suffix: "" },
    ];
    if (input.fastOrchestrator) {
      attempts.push({ model: selection, mode: effectiveMode, suffix: "-fallback" });
    }
    if (fallbackMode && fallbackMode !== effectiveMode) {
      attempts.push({ model: primarySelection, mode: fallbackMode, suffix: "-mode-fallback" });
      if (input.fastOrchestrator) {
        attempts.push({ model: selection, mode: fallbackMode, suffix: "-fallback-mode" });
      }
    }
    let launched: unknown;
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        launched = await this.#call("t3_thread_launch", launchArgs(attempt.model, attempt.mode, attempt.suffix), 60_000);
        lastError = undefined;
        break;
      } catch (error) {
        if (!(error instanceof T3AutomationError) || error.code === "AUTH_REQUIRED" || error.code === "INVALID_RESPONSE") throw error;
        lastError = error;
      }
    }
    if (lastError !== undefined) throw lastError;
    if (!object(launched) || !text(launched.threadId)) invalidResponse();
    return { threadId: launched.threadId, threadUrl: await this.#threadUrl(url, launched.threadId) };
  }

  async #uploadImage(url: string, image: TaskImageData): Promise<{ id: string; type: "image" | "file"; name: string; mimeType: string; sizeBytes: number }> {
    const { name, mimeType, sizeBytes, bytes } = image;
    const type: "image" | "file" = isTaskImageAttachment(image) ? "image" : "file";
    const upload = { type, name, mimeType, sizeBytes };
    const prepared = await this.#call("t3_attachment_prepare_upload", { upload });
    if (!object(prepared) || !text(prepared.attachmentId) || !text(prepared.relativeUrl) || !prepared.relativeUrl.startsWith("/")) invalidResponse();
    let uploadUrl: URL;
    try { uploadUrl = new URL(prepared.relativeUrl, url); } catch { invalidResponse(); }
    if (uploadUrl.origin !== new URL(url).origin || uploadUrl.username || uploadUrl.password || uploadUrl.hash) invalidResponse();
    const response = await this.#fetch(uploadUrl, { method: "POST", headers: { "content-type": mimeType }, body: bytes }, 60_000);
    await response.body?.cancel();
    if (!response.ok) throw new T3AutomationError("UNAVAILABLE", `TODO 附件未能上传到 T3（HTTP ${response.status}）。`);
    return { id: prepared.attachmentId, ...upload };
  }

  async followup(threadId: string, prompt: string, commandId: string): Promise<void> {
    if (prompt.trim() === "") throw new T3AutomationError("INVALID_INPUT", "请填写返工说明。");
    const { thread } = await this.#read(threadId, { limit: 1, runLimit: 1 });
    const failed = thread.status === "failed" || STOPPED_STATUSES.has(thread.status);
    // 凭据换新后同一 clientRequestId 不再去重：最后一条用户消息已是这条说明且没有失败，说明已投递过。
    const lastUser = (await this.#tail(threadId)).filter((item) => item.type === "user_message").at(-1);
    if (!failed && lastUser && !lastUser.textTruncated && lastUser.text === prompt) return;
    if (thread.activeRunId || (LIVE_STATUSES.has(thread.status) && thread.status !== "idle") || thread.pendingRequestCount > 0) {
      throw new T3AutomationError("INVALID_INPUT", "T3 会话仍在执行，请等待当前任务结束后再提交返工。");
    }
    await this.#call("t3_thread_send", { threadId, message: prompt, mode: "queue", clientRequestId: `u-brain-todo-feedback-${commandId}` });
  }

  async inspect(threadId: string, requirementsFirst = false): Promise<Awaited<ReturnType<TaskAutomationPort["inspect"]>>> {
    const page = requirementsFirst ? { afterPosition: -1, limit: 8 } : { limit: 1 };
    let initial: T3ThreadRead;
    try { initial = await this.#read(threadId, { ...page, runLimit: 1 }); }
    catch (error) {
      if (error instanceof T3AutomationError && error.code === "NOT_FOUND") return { state: "failed", summary: "", error: "T3 会话已删除或归档，请人工检查。" };
      throw error;
    }
    const { thread } = initial;
    if (thread.archived) return { state: "failed", summary: "", error: "T3 会话已删除或归档，请人工检查。" };
    if (thread.status === "failed") return { state: "failed", summary: "", error: "T3 任务执行失败，请在 T3 中检查。" };
    if (STOPPED_STATUSES.has(thread.status)) return { state: "failed", summary: "", error: "T3 任务已中断，请在 T3 中检查后重试。" };
    if (requirementsFirst) {
      const firstRun = initial.items.find((item) => item.type === "user_message")?.runId;
      if (thread.interactionMode !== "default" || !firstRun || firstRun === thread.latestRunId) return { state: "planning", summary: "" };
    }
    if (thread.status !== "completed" || thread.activeRunId || thread.pendingRequestCount > 0) return { state: "running", summary: "" };

    const tail = await this.#tail(threadId);
    const lastUser = tail.filter((item) => item.type === "user_message").at(-1);
    const answers = tail.filter((item) => item.type === "assistant_message" && item.runId === thread.latestRunId);
    const answer = answers.at(-1);
    // 新消息已写入但新一轮尚未投影时，不能把上一轮 completed 当作返工完成。
    if (!answer || (lastUser && lastUser.position > answer.position)) return { state: "running", summary: "" };
    return { state: "ready", summary: (answer.text ?? "").slice(0, 32_000) };
  }

  /** 全部项目的顶层会话及状态（最新的 100 个）：给手机推送监视「做完一轮 / 等你处理」用，不读会话内容。 */
  async threadStates(): Promise<T3ThreadBrief[]> {
    const value = await this.#call("t3_thread_list", { allProjects: true, limit: 100 });
    if (!object(value) || !Array.isArray(value.threads) || !value.threads.every(isThreadBrief)) invalidResponse();
    return value.threads
      .filter((thread) => !thread.parentThreadId)
      .map((thread) => ({
        threadId: thread.threadId,
        title: thread.title,
        status: thread.status,
        latestRunId: thread.latestRunId,
        snoozed: thread.snoozed === true,
        link: typeof thread.link === "string" ? thread.link : null,
      }));
  }

  /** 会话最后一条助手回答（推送正文用）；没有时返回空串。 */
  async latestAnswer(threadId: string): Promise<string> {
    const answer = (await this.#tail(threadId)).filter((item) => item.type === "assistant_message").at(-1);
    return answer?.text ?? "";
  }

  /** 从手机发一条消息：会话空闲就开始新一轮，正在执行就排到下一轮，不打断。返回 T3 的投递结果。 */
  async sendMessage(threadId: string, message: string, requestId: string): Promise<string> {
    if (message.trim() === "") throw new T3AutomationError("INVALID_INPUT", "消息不能为空。");
    const sent = await this.#call("t3_thread_send", { threadId, message, mode: "queue", clientRequestId: `u-brain-telegram-${requestId}` });
    if (!object(sent) || !text(sent.delivery)) invalidResponse();
    return sent.delivery;
  }

  /** 读取指定会话的最近消息列表，供移动端主控持续对话流展示。 */
  async readMessages(threadId: string, options?: { afterPosition?: number; limit?: number }): Promise<T3ThreadConversation> {
    const limit = Math.min(200, Math.max(1, options?.limit ?? 80));
    let initial: T3ThreadRead;
    if (options?.afterPosition !== undefined) {
      initial = await this.#read(threadId, {
        limit,
        runLimit: 20,
        ...(options.afterPosition > 0 ? { afterPosition: options.afterPosition } : {}),
      });
    } else {
      const knownCount = this.#threadItemCounts.get(threadId);
      if (knownCount !== undefined && knownCount > limit) {
        initial = await this.#read(threadId, {
          limit,
          runLimit: 20,
          afterPosition: knownCount - limit,
        });
      } else {
        initial = await this.#read(threadId, { limit, runLimit: 20 });
        if (initial.thread.itemCount > limit) {
          initial = await this.#read(threadId, {
            limit,
            runLimit: 20,
            afterPosition: initial.thread.itemCount - limit,
          });
        }
      }
    }
    const { thread, items } = initial;
    const state: T3ThreadConversation["state"] =
      thread.archived || thread.status === "failed" || STOPPED_STATUSES.has(thread.status)
        ? "failed"
        : thread.status === "waiting"
          ? "waiting"
          : thread.activeRunId || (LIVE_STATUSES.has(thread.status) && thread.status !== "idle") || thread.pendingRequestCount > 0
            ? "running"
            : "ready";
    const sortedItems = [...items].sort((a, b) => a.position - b.position);
    const messages = sortedItems
      .filter((item): item is T3Item & { text: string } =>
        (item.type === "user_message" || item.type === "assistant_message") && typeof item.text === "string",
      )
      .flatMap((item): T3ThreadMessage[] => {
        const cleaned = item.type === "user_message" ? stripMasterAgentPreamble(item.text) : item.text;
        if (cleaned.trim() === "") return [];
        return [{
          position: item.position,
          role: item.type === "user_message" ? "user" : "assistant",
          text: cleaned,
          runId: item.runId,
        }];
      });
    let activity: string | null = null;
    if (thread.status === "preparing" || thread.status === "queued" || thread.status === "starting") {
      activity = "正在唤醒主控会话…";
    } else if (state === "waiting") {
      activity = "等待确认或补充信息…";
    } else if (state === "running") {
      const activeTail = thread.activeRunId
        ? sortedItems.filter((item) => item.runId === thread.activeRunId).at(-1)
        : sortedItems.at(-1);
      activity = activeTail?.type === "assistant_message" ? "正在整理回复…" : "正在思考与调度…";
    }
    const url = await this.#url().catch(() => null);
    const threadUrl = url ? await this.#threadUrl(url, threadId).catch(() => null) : null;
    return {
      threadId,
      state,
      rawStatus: thread.status,
      threadUrl,
      itemCount: thread.itemCount,
      activity,
      messages,
    };
  }

  /** 选一个可用的默认项目启动主控会话：优先带默认模型配置的项目，其次有历史会话模型的项目。 */
  async defaultDispatchProject(): Promise<{ id: string; name: string } | null> {
    const projects = await this.#projects();
    if (projects.length === 0) return null;
    for (const project of projects) {
      if (model(project.defaultModelSelection)) return { id: project.id, name: project.title };
    }
    for (const project of projects) {
      try {
        const history = await this.#threads(project.id);
        if (history.some((thread) => text(thread.providerInstanceId) && text(thread.model))) {
          return { id: project.id, name: project.title };
        }
      } catch {
        // 单个项目读历史失败继续看下一个。
      }
    }
    const first = projects[0]!;
    return { id: first.id, name: first.title };
  }

  /** daemon 退出时撤销由此适配器签发的凭据；外部注入凭据不动。 */
  async close(): Promise<void> {
    const credential = this.#credential;
    this.#credential = null;
    this.#session = null;
    if (credential) await this.#revoke((label) => label === credential.label).catch(() => undefined);
  }

  async #url(): Promise<string> {
    const url = normalizeT3Url(await this.#options.getUrl());
    if (!url) throw new T3AutomationError("INVALID_INPUT", "TODO 只能连接本机 T3 HTTP(S) 服务根地址。");
    return url;
  }

  async #capabilities(): Promise<{ runtimeModes: Map<string, string[]>; driverKinds: Map<string, string> } | null> {
    if (this.#capabilitiesCache && Date.now() < this.#capabilitiesCache.expiresAt) {
      return this.#capabilitiesCache;
    }
    try {
      const value = await this.#call("orchestrator_capabilities", {});
      if (!object(value) || !Array.isArray(value.providers)) return null;
      const runtimeModes = new Map<string, string[]>();
      const driverKinds = new Map<string, string>();
      for (const provider of value.providers) {
        if (!object(provider) || !text(provider.providerInstanceId)) continue;
        if (text(provider.driverKind)) {
          driverKinds.set(provider.providerInstanceId, provider.driverKind);
        }
        if (Array.isArray(provider.runtimeModes)) {
          const modes = provider.runtimeModes.filter((item): item is string => text(item));
          if (modes.length > 0) runtimeModes.set(provider.providerInstanceId, modes);
        }
      }
      this.#capabilitiesCache = { expiresAt: Date.now() + CAPABILITIES_CACHE_TTL_MS, runtimeModes, driverKinds };
      return this.#capabilitiesCache;
    } catch {
      return null;
    }
  }

  async #providerRuntimeModes(instanceId: string): Promise<string[] | null> {
    const capabilities = await this.#capabilities();
    return capabilities?.runtimeModes.get(instanceId) ?? null;
  }

  async #providerDriverKind(instanceId: string | undefined): Promise<string | null> {
    if (!instanceId) return null;
    const capabilities = await this.#capabilities();
    return capabilities?.driverKinds.get(instanceId) ?? normalizeProviderDriverKind(instanceId);
  }

  async #projects(forceRefresh = false): Promise<T3Project[]> {
    if (!forceRefresh && this.#projectsCache && Date.now() < this.#projectsCache.expiresAt) {
      return this.#projectsCache.projects;
    }
    const projects: T3Project[] = [];
    let cursor = 0;
    for (let page = 0; page < 50; page++) {
      const value = await this.#call("t3_project_list", { limit: 100, ...(cursor > 0 ? { cursor } : {}) });
      if (!object(value) || !Array.isArray(value.projects) || !value.projects.every(isProject) ||
        !(value.nextCursor === null || value.nextCursor === undefined || typeof value.nextCursor === "number")) invalidResponse();
      projects.push(...value.projects.filter((project) => !project.deletedAt));
      if (typeof value.nextCursor !== "number") {
        this.#projectsCache = { expiresAt: Date.now() + PROJECTS_CACHE_TTL_MS, projects };
        return projects;
      }
      if (value.nextCursor <= cursor) invalidResponse();
      cursor = value.nextCursor;
    }
    this.#projectsCache = { expiresAt: Date.now() + PROJECTS_CACHE_TTL_MS, projects };
    return projects;
  }

  async #directoryProject(cwd: string, projects: T3Project[]): Promise<T3Project> {
    const existing = projects.find((project) => resolve(project.workspaceRoot) === resolve(cwd));
    if (existing) return existing;
    const created = await this.createProject({ name: basename(cwd), cwd });
    return { id: created.id, title: created.name, workspaceRoot: created.cwd };
  }

  /** 项目最近的会话，新的在前；只取模型与权限，不读会话内容。 */
  async #threads(projectId: string, titleContains?: string): Promise<T3ThreadSummary[]> {
    const value = await this.#call("t3_thread_list", { projectId, limit: 20, ...(titleContains ? { titleContains } : {}) });
    if (!object(value) || !Array.isArray(value.threads) || !value.threads.every(isThreadSummary)) invalidResponse();
    return value.threads;
  }

  async #launched(projectId: string, title: string, worktreePath: string | null, launchReference: string | null): Promise<string | null> {
    for (const candidate of (await this.#threads(projectId, title)).filter((thread) => thread.title === title)) {
      const { thread, items } = await this.#read(candidate.threadId, { limit: launchReference ? 8 : 1, runLimit: 1 });
      if (!thread.archived && thread.worktreePath === worktreePath &&
        (!launchReference || hasLaunchReference(items.find((item) => item.type === "user_message")?.text, launchReference))) return thread.threadId;
    }
    return null;
  }

  async #read(threadId: string, extra: Record<string, unknown>): Promise<T3ThreadRead> {
    const value = await this.#call("t3_thread_read", { threadId, view: "messages", maxCharsPerItem: 32_000, ...extra });
    if (!object(value) || !isThreadState(value.thread) || value.thread.threadId !== threadId ||
      !Array.isArray(value.items) || !value.items.every(isItem)) invalidResponse();
    this.#threadItemCounts.set(threadId, value.thread.itemCount);
    return value as unknown as T3ThreadRead;
  }

  /** 会话末尾的用户与助手消息，按位置升序。 */
  async #tail(threadId: string): Promise<T3Item[]> {
    const { items } = await this.#read(threadId, { limit: TAIL_ITEMS, runLimit: 1 });
    return [...items].sort((a, b) => a.position - b.position);
  }

  async #threadUrl(url: string, threadId: string): Promise<string> {
    let environmentId = this.#environments.get(url);
    if (!environmentId) {
      const descriptor = await this.#json(await this.#fetch(new URL("/.well-known/t3/environment", url), { method: "GET" }));
      if (!object(descriptor) || !text(descriptor.environmentId)) invalidResponse();
      environmentId = descriptor.environmentId;
      this.#environments.set(url, environmentId);
    }
    return new URL(`${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`, url).toString();
  }

  /** 调用一个 T3 MCP 工具，返回其结构化结果。凭据失效或 MCP 会话过期时各重建一次。 */
  async #call(name: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<unknown> {
    const url = await this.#url();
    for (let attempt = 0; ; attempt++) {
      const token = await this.#token(url);
      const sessionId = await this.#open(url, token);
      const id = ++this.#rpcId;
      const response = await this.#post(url, token, sessionId, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, timeoutMs);
      if (attempt === 0 && response.status === 401 && !this.#options.getToken) {
        this.#credential = null;
        this.#session = null;
        continue;
      }
      if (attempt === 0 && response.status === 404 && sessionId !== null) {
        this.#session = null;
        continue;
      }
      const result = await this.#rpcResult(response, id);
      if (!object(result)) invalidResponse();
      if (result.isError === true) throw this.#toolError(result);
      if (result.structuredContent !== undefined) return result.structuredContent;
      const first = Array.isArray(result.content) ? result.content[0] : undefined;
      if (!object(first) || typeof first.text !== "string") invalidResponse();
      try { return JSON.parse(first.text); } catch { invalidResponse(); }
    }
  }

  #toolError(result: Record<string, unknown>): T3AutomationError {
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    let failure: unknown;
    try { failure = object(first) && typeof first.text === "string" ? JSON.parse(first.text) : undefined; } catch { failure = undefined; }
    if (object(failure) && failure.code === "thread_not_found") return new T3AutomationError("NOT_FOUND", "T3 会话不存在或已删除。");
    const detail = object(failure) && typeof failure.message === "string" ? failure.message.slice(0, 500) : "未知原因";
    return new T3AutomationError("UNAVAILABLE", `T3 拒绝了请求：${detail}`);
  }

  async #open(url: string, token: string): Promise<string | null> {
    if (this.#session && this.#session.url === url && this.#session.token === token) return this.#session.id;
    if (this.#opening) return this.#opening;
    this.#opening = (async () => {
      const id = ++this.#rpcId;
      const response = await this.#post(url, token, null, {
        jsonrpc: "2.0", id, method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "u-brain-todo", version: "1" } },
      }, 20_000);
      const sessionId = response.headers.get("mcp-session-id");
      await this.#rpcResult(response, id);
      const ack = await this.#post(url, token, sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }, 20_000);
      if (ack.status === 401 || ack.status === 403) unauthorized();
      if (!ack.ok) throw new T3AutomationError("UNAVAILABLE", `T3 接口请求失败（HTTP ${ack.status}），请在 T3 中检查任务状态。`);
      await ack.body?.cancel();
      this.#session = { url, token, id: sessionId };
      return sessionId;
    })();
    try { return await this.#opening; } finally { this.#opening = null; }
  }

  async #post(url: string, token: string, sessionId: string | null, body: unknown, timeoutMs: number): Promise<Response> {
    return this.#fetch(new URL("/mcp", url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL, ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    }, timeoutMs);
  }

  async #fetch(url: URL, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
    try {
      return await (this.#options.fetch ?? fetch)(url, { ...init, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new T3AutomationError("UNAVAILABLE", "无法连接 T3 或请求超时；任务派发编号已保留，请先在 T3 中确认派发结果。");
    }
  }

  async #json(response: Response): Promise<unknown> {
    if (response.status === 401 || response.status === 403) unauthorized();
    if (!response.ok) throw new T3AutomationError("UNAVAILABLE", `T3 接口请求失败（HTTP ${response.status}），请在 T3 中检查任务状态。`);
    try { return await response.json(); } catch { invalidResponse(); }
  }

  /** MCP 可以按 JSON 或 SSE 回复；只取与请求 id 对应的那条消息。 */
  async #rpcResult(response: Response, id: number): Promise<unknown> {
    if (response.status === 401 || response.status === 403) unauthorized();
    if (!response.ok) throw new T3AutomationError("UNAVAILABLE", `T3 接口请求失败（HTTP ${response.status}），请在 T3 中检查任务状态。`);
    let messages: unknown[];
    try {
      if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        messages = (await response.text()).split(/\r?\n/u).filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)) as unknown);
      } else {
        const value = await response.json() as unknown;
        messages = Array.isArray(value) ? value : [value];
      }
    } catch { invalidResponse(); }
    const message = messages.find((item) => object(item) && item.id === id);
    if (!object(message)) invalidResponse();
    if (object(message.error)) throw new T3AutomationError("UNAVAILABLE", `T3 接口调用失败（${typeof message.error.code === "number" ? message.error.code : "未知"}），请检查 T3 版本。`);
    return message.result;
  }

  async #token(url: string): Promise<string> {
    if (this.#options.getToken) return this.#options.getToken();
    if (this.#credential && this.#credential.expiresAt > Date.now() + REFRESH_BEFORE_MS) return this.#credential.token;
    if (this.#issuing) return this.#issuing;
    this.#issuing = this.#issueToken(url);
    try { return await this.#issuing; } finally { this.#issuing = null; }
  }

  /**
   * 给指挥台 iframe 的浏览器会话签发一次性配对凭据（5 分钟、一次性）：只交给转发立刻去换登录 Cookie，
   * 不保存、不打印。标签与 TODO 的 MCP 授权分开，避免被它的清理误撤销。
   */
  async pairingCredential(): Promise<string> {
    const raw = await this.#runCli(["auth", "pairing", "create", "--ttl", "5m", "--label", "U-Brain 指挥台", "--json"]);
    const credential = (JSON.parse(raw) as Record<string, unknown>).credential;
    if (!text(credential)) invalidResponse();
    return credential;
  }

  /** 配对码 → 注册 MCP 客户端 → 用配对码批准 → 换取访问令牌（PKCE）。 */
  async #issueToken(url: string): Promise<string> {
    if (!this.#staleCleaned) {
      // 上次 daemon 异常退出时留下的凭据不再使用，先撤销。
      this.#staleCleaned = true;
      await this.#revoke((label) => label === CLIENT_LABEL || label.startsWith(`${CLIENT_LABEL} `)).catch(() => undefined);
    }
    const label = `${CLIENT_LABEL} ${randomBytes(4).toString("hex")}`;
    let code: unknown;
    try { code = (JSON.parse(await this.#runCli(["auth", "pairing", "create", "--ttl", "5m", "--label", label, "--json"])) as Record<string, unknown>).credential; }
    catch { throw new T3AutomationError("AUTH_REQUIRED", "无法通过本机 t3 CLI 为 TODO 授权。请先启动 T3，并确认 t3 auth pairing create 可用。"); }
    if (!text(code)) invalidResponse();

    const resource = new URL("/mcp", url).toString();
    const registered = await this.#json(await this.#fetch(new URL("/oauth/mcp/register", url), {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: label, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
    }));
    if (!object(registered) || !text(registered.client_id)) invalidResponse();

    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const decided = await this.#json(await this.#fetch(new URL("/oauth/mcp/decision", url), {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        authorization: {
          response_type: "code", client_id: registered.client_id, redirect_uri: REDIRECT_URI, resource, state,
          code_challenge: base64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
        },
        decision: { _tag: "pairing-code", access: CLIENT_ACCESS, code },
      }),
    }));
    if (!object(decided) || !text(decided.redirectTo)) invalidResponse();
    const redirect = URL.parse(decided.redirectTo);
    const authorization = redirect?.searchParams.get("code");
    if (!authorization || redirect?.searchParams.get("state") !== state) unauthorized();

    const issued = await this.#json(await this.#fetch(new URL("/oauth/mcp/token", url), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: authorization, redirect_uri: REDIRECT_URI,
        client_id: registered.client_id, code_verifier: verifier, resource,
      }).toString(),
    }));
    if (!object(issued) || !text(issued.access_token) || typeof issued.expires_in !== "number" || issued.expires_in <= 0) invalidResponse();
    const previous = this.#credential;
    this.#credential = { token: issued.access_token, label, expiresAt: Date.now() + issued.expires_in * 1000 };
    this.#session = null;
    if (previous) await this.#revoke((value) => value === previous.label).catch(() => undefined);
    return issued.access_token;
  }

  /** 按标签撤销本适配器签发过的 T3 会话；输出不含令牌。 */
  async #revoke(match: (label: string) => boolean): Promise<void> {
    const value = JSON.parse(await this.#runCli(["auth", "session", "list", "--json"])) as unknown;
    const sessions = Array.isArray(value) ? value : object(value) && Array.isArray(value.sessions) ? value.sessions : [];
    for (const session of sessions) {
      if (!object(session) || !text(session.sessionId)) continue;
      const label = object(session.client) && typeof session.client.label === "string" ? session.client.label : "";
      if (match(label)) await this.#runCli(["auth", "session", "revoke", session.sessionId]).catch(() => undefined);
    }
  }

  async #runCli(args: string[]): Promise<string> {
    if (this.#options.runCli) return this.#options.runCli(args);
    const env = this.#options.env ?? process.env;
    const paths = [
      ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => join(path, "t3")),
      join(this.#options.homeDir ?? homedir(), ".local", "bin", "t3"),
      "/opt/homebrew/bin/t3", "/usr/local/bin/t3",
    ];
    let binary: string | undefined;
    for (const path of paths) {
      try { await access(path, constants.X_OK); binary = path; break; } catch { /* 下一个路径。 */ }
    }
    if (!binary) throw new Error("T3 CLI unavailable");
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "ignore"] });
      let stdout = "";
      const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("T3 CLI timed out")); }, 15_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 1_048_576) { child.kill("SIGTERM"); reject(new Error("T3 CLI output limit")); }
      });
      child.once("error", () => { clearTimeout(timeout); reject(new Error("T3 CLI failed")); });
      child.once("close", (code) => { clearTimeout(timeout); if (code === 0) resolve(stdout); else reject(new Error("T3 CLI failed")); });
    });
  }
}
