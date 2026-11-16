import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import type { TaskAutomationPort } from "../../tasks/types.js";
import { normalizeT3Url } from "./index.js";

/** T3 0.0.45 的公开 HTTP orchestration 协议；不读取或修改 T3 数据库。 */
interface ModelSelection { instanceId: string; model: string; options?: unknown }
interface T3Project { id: string; title: string; workspaceRoot: string; defaultModelSelection?: ModelSelection | null }
interface T3Message { id: string; role: string; text: string; streaming: boolean; createdAt: string }
interface T3Thread {
  id: string;
  projectId: string;
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode: string;
  branch: string | null;
  worktreePath: string | null;
  updatedAt: string;
  archivedAt?: string | null;
  deletedAt?: string | null;
  messages?: T3Message[];
  latestTurn: { state: string; requestedAt: string; assistantMessageId: string | null } | null;
  session: { status: string; lastError: string | null; activeTurnId: string | null } | null;
}

interface ShellSnapshot { projects: T3Project[]; threads: T3Thread[] }
type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export interface T3AutomationOptions {
  getUrl: () => Promise<string>;
  /** 测试或自定义本机 T3 实例可注入；默认由本机 CLI 签发短期 token，仅留内存。 */
  getToken?: () => Promise<string>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** 测试用，替代 t3 CLI。stdout 可能包含 token，调用方不得记录。 */
  runCli?: (args: string[]) => Promise<string>;
}

export class T3AutomationError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "UNAVAILABLE" | "INVALID_RESPONSE" | "INVALID_INPUT", message: string) {
    super(message);
    this.name = "T3AutomationError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function model(value: unknown): value is ModelSelection {
  return object(value) && typeof value.instanceId === "string" && value.instanceId !== "" &&
    typeof value.model === "string" && value.model !== "";
}

function runtimeMode(value: unknown): RuntimeMode | undefined {
  return value === "approval-required" || value === "auto-accept-edits" || value === "auto" || value === "full-access" ? value : undefined;
}

function isProject(value: unknown): value is T3Project {
  return object(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.workspaceRoot === "string";
}

function isThread(value: unknown): value is T3Thread {
  return object(value) && typeof value.id === "string" && typeof value.projectId === "string" &&
    typeof value.updatedAt === "string";
}

/** 不将认证错误原文返回界面：上游错误和 CLI stdout 都可能含凭据。 */
function invalidResponse(): never {
  throw new T3AutomationError("INVALID_RESPONSE", "T3 接口返回格式不兼容，请检查 T3 版本。当前适配 T3 0.0.45。");
}

export class T3Automation implements TaskAutomationPort {
  readonly #options: T3AutomationOptions;
  #credential: { token: string; sessionId: string; expiresAt: number } | null = null;
  #issuing: Promise<string> | null = null;

  constructor(options: T3AutomationOptions) { this.#options = options; }

  async projects(): Promise<Array<{ id: string; name: string; cwd: string }>> {
    const snapshot = await this.#shell();
    return snapshot.projects.map((project) => ({ id: project.id, name: project.title, cwd: project.workspaceRoot }));
  }

  async start(input: Parameters<TaskAutomationPort["start"]>[0]): Promise<{ threadId: string; threadUrl: string }> {
    if (!isAbsolute(input.cwd) || !input.threadId || input.prompt.trim() === "") {
      throw new T3AutomationError("INVALID_INPUT", "任务必须有工作目录、T3 会话编号和任务说明。");
    }
    const url = await this.#url();
    const snapshot = await this.#shell(url);
    const project = snapshot.projects.find((item) => item.id === input.projectId);
    if (!project) throw new T3AutomationError("INVALID_INPUT", "T3 中已找不到这个项目，请重新选择项目。");
    const existing = snapshot.threads.find((thread) => thread.id === input.threadId);
    if (existing && (existing.projectId !== project.id || existing.worktreePath !== input.cwd || existing.branch !== input.branch)) {
      throw new T3AutomationError("INVALID_INPUT", "任务会话与项目、分支或工作目录不一致，已停止派发。");
    }
    const selection = existing?.modelSelection ?? project.defaultModelSelection ?? snapshot.threads
      .filter((thread) => thread.projectId === project.id && model(thread.modelSelection))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.modelSelection;
    if (!model(selection)) throw new T3AutomationError("INVALID_INPUT", "请先在 T3 中为这个项目选择模型或创建一次会话，再启动 TODO。");
    // 沿用用户在 T3 已选择的权限；无历史配置时使用自动审批模式，不提升为 full-access。
    const mode = runtimeMode(existing?.runtimeMode) ?? runtimeMode(snapshot.threads
      .filter((thread) => thread.projectId === project.id && !thread.deletedAt && runtimeMode(thread.runtimeMode))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.runtimeMode) ?? "auto";
    const descriptor = await this.#request("GET", "/.well-known/t3/environment", undefined, url);
    if (!object(descriptor) || typeof descriptor.environmentId !== "string") invalidResponse();
    const result = { threadId: input.threadId, threadUrl: new URL(`${encodeURIComponent(descriptor.environmentId)}/${encodeURIComponent(input.threadId)}`, url).toString() };
    const messageId = `u-brain-todo-message-${input.threadId}`;
    if (existing && (await this.#thread(input.threadId)).messages?.some((message) => message.id === messageId)) return result;

    const createdAt = new Date().toISOString();
    // 稳定 commandId/messageId + 原子 bootstrap：重试不会另建 thread 或重复开始同一个任务。
    await this.#request("POST", "/api/orchestration/dispatch", {
      type: "thread.turn.start",
      commandId: `u-brain-todo-start-${input.threadId}`,
      threadId: input.threadId,
      message: { messageId, role: "user", text: input.prompt, attachments: [] },
      modelSelection: selection,
      runtimeMode: mode,
      interactionMode: "default",
      createdAt,
      ...(!existing ? { bootstrap: { createThread: {
        projectId: project.id, title: input.title, modelSelection: selection,
        runtimeMode: mode, interactionMode: "default", branch: input.branch,
        worktreePath: input.cwd, createdAt,
      } } } : {}),
    }, url);
    return result;
  }

  async followup(threadId: string, prompt: string, commandId: string): Promise<void> {
    if (prompt.trim() === "") throw new T3AutomationError("INVALID_INPUT", "请填写返工说明。");
    const thread = await this.#thread(threadId);
    const messageId = `u-brain-todo-feedback-${commandId}`;
    // 未知投递结果用相同消息 ID 重试；消息已持久化即不再发第二次。
    if (thread.messages?.some((message) => message.id === messageId)) return;
    if (thread.latestTurn?.state === "running" || thread.session?.activeTurnId) {
      throw new T3AutomationError("INVALID_INPUT", "T3 会话仍在执行，请等待当前任务结束后再提交返工。");
    }
    await this.#request("POST", "/api/orchestration/dispatch", {
      type: "thread.turn.start", commandId, threadId,
      message: { messageId, role: "user", text: prompt, attachments: [] },
      runtimeMode: runtimeMode(thread.runtimeMode) ?? "auto", interactionMode: "default", createdAt: new Date().toISOString(),
    });
  }

  async inspect(threadId: string): Promise<Awaited<ReturnType<TaskAutomationPort["inspect"]>>> {
    const thread = await this.#thread(threadId);
    const messages = thread.messages ?? [];
    const latestUser = messages.filter((message) => message.role === "user").at(-1);
    const turn = thread.latestTurn;
    const assistant = messages.find((message) => message.id === turn?.assistantMessageId);
    const summary = (assistant?.text ?? messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "").slice(0, 32_000);
    if (thread.deletedAt || thread.archivedAt) return { state: "failed", summary, error: "T3 会话已删除或归档，请人工检查。" };
    // 新消息已写入但新 turn 尚未投影时，不能把上一轮 completed 当作返工完成。
    if (latestUser && (!turn || latestUser.createdAt > turn.requestedAt)) return { state: "running", summary };
    if (turn?.state === "error" || thread.session?.status === "error") {
      return { state: "failed", summary, error: "T3 任务执行失败，请在 T3 中检查。" };
    }
    if (turn?.state === "interrupted" || thread.session?.status === "interrupted" || thread.session?.status === "stopped") {
      return { state: "failed", summary, error: "T3 任务已中断，请在 T3 中检查后重试。" };
    }
    if (turn?.state === "completed" && assistant?.role === "assistant" && !assistant.streaming &&
      (!latestUser || assistant.createdAt >= latestUser.createdAt) && !thread.session?.activeTurnId) {
      return { state: "ready", summary };
    }
    return { state: "running", summary };
  }

  /** daemon 退出时撤销由此适配器签发的会话；外部注入凭据不动。 */
  async close(): Promise<void> {
    const credential = this.#credential;
    this.#credential = null;
    if (credential) await this.#runCli(["auth", "session", "revoke", credential.sessionId]).catch(() => undefined);
  }

  async #url(): Promise<string> {
    const url = normalizeT3Url(await this.#options.getUrl());
    if (!url) throw new T3AutomationError("INVALID_INPUT", "TODO 只能连接本机 T3 HTTP(S) 服务根地址。");
    return url;
  }

  async #shell(url?: string): Promise<ShellSnapshot> {
    const value = await this.#request("GET", "/api/orchestration/shell", undefined, url);
    if (!object(value) || !Array.isArray(value.projects) || !value.projects.every(isProject) ||
      !Array.isArray(value.threads) || !value.threads.every(isThread)) invalidResponse();
    return value as unknown as ShellSnapshot;
  }

  async #thread(threadId: string): Promise<T3Thread> {
    const value = await this.#request("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}?turnLimit=1`);
    if (!object(value) || !isThread(value.thread) || value.thread.id !== threadId || !Array.isArray(value.thread.messages)) invalidResponse();
    const thread = value.thread;
    if (!thread.messages?.every((message) => object(message) && typeof message.id === "string" &&
      typeof message.role === "string" && typeof message.text === "string" && typeof message.createdAt === "string" && typeof message.streaming === "boolean")) invalidResponse();
    if (thread.latestTurn !== null && (!object(thread.latestTurn) || typeof thread.latestTurn.state !== "string" ||
      typeof thread.latestTurn.requestedAt !== "string" || !(thread.latestTurn.assistantMessageId === null || typeof thread.latestTurn.assistantMessageId === "string"))) invalidResponse();
    if (thread.session !== null && (!object(thread.session) || typeof thread.session.status !== "string" ||
      !(thread.session.activeTurnId === null || typeof thread.session.activeTurnId === "string"))) invalidResponse();
    return thread;
  }

  async #request(method: "GET" | "POST", path: string, body?: unknown, baseUrl?: string): Promise<unknown> {
    const url = baseUrl ?? await this.#url();
    const token = await this.#token();
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(new URL(path, url), {
        method, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new T3AutomationError("UNAVAILABLE", "无法连接 T3 或请求超时；任务会话编号已保留，请先在 T3 中确认派发结果。");
    }
    if (response.status === 401 || response.status === 403) {
      throw new T3AutomationError("AUTH_REQUIRED", "T3 未授权。请确认该地址对应本机 t3 CLI 的服务；自定义 T3 实例需提供该实例的授权。");
    }
    if (!response.ok) throw new T3AutomationError("UNAVAILABLE", `T3 接口请求失败（HTTP ${response.status}），请在 T3 中检查任务状态。`);
    try { return await response.json(); } catch { invalidResponse(); }
  }

  async #token(): Promise<string> {
    if (this.#options.getToken) return this.#options.getToken();
    if (this.#credential && this.#credential.expiresAt > Date.now() + 60_000) return this.#credential.token;
    if (this.#issuing) return this.#issuing;
    this.#issuing = this.#issueToken();
    try { return await this.#issuing; } finally { this.#issuing = null; }
  }

  async #issueToken(): Promise<string> {
    let value: unknown;
    try { value = JSON.parse(await this.#runCli(["auth", "session", "issue", "--ttl", "1h", "--label", "U-Brain TODO", "--json"])); }
    catch { throw new T3AutomationError("AUTH_REQUIRED", "无法通过本机 t3 CLI 为 TODO 授权。请先启动 T3，并确认 t3 auth session issue 可用。"); }
    if (!object(value) || typeof value.token !== "string" || !value.token || typeof value.sessionId !== "string" || typeof value.expiresAt !== "string") invalidResponse();
    const expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) invalidResponse();
    const previous = this.#credential;
    this.#credential = { token: value.token, sessionId: value.sessionId, expiresAt };
    if (previous) await this.#runCli(["auth", "session", "revoke", previous.sessionId]).catch(() => undefined);
    return value.token;
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
        if (stdout.length > 65_536) { child.kill("SIGTERM"); reject(new Error("T3 CLI output limit")); }
      });
      child.once("error", () => { clearTimeout(timeout); reject(new Error("T3 CLI failed")); });
      child.once("close", (code) => { clearTimeout(timeout); if (code === 0) resolve(stdout); else reject(new Error("T3 CLI failed")); });
    });
  }
}
