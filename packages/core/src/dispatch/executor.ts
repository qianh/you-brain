import {
  DISPATCH_KINDS,
  DispatchCommandSchema,
  minMode,
  verifyCommand,
  type CmdFrame,
  type DispatchCommand,
  type HelloDispatch,
  type LaunchModeName,
  type RdDisplayInfo,
  type RdIceCandidate,
  type RdPermissions,
  type RuntimeModeName,
} from "@you-brain/protocol";

import type { RemoteDesktopPort } from "../deck/remote-desktop/session-manager.js";
import {
  MASTER_AGENT_PREAMBLE_END,
  MASTER_AGENT_PREAMBLE_START,
  T3AutomationError,
  type T3ThreadBrief,
  type T3ThreadConversation,
} from "../deck/t3/automation.js";
import { TaskError } from "../tasks/service.js";
import { isTaskImageAttachment, type TaskBoard, type TaskHttpPort, type TaskReview } from "../tasks/types.js";
import { AgentSessionStore } from "./agent-sessions.js";
import { AuditLog } from "./audit.js";
import type { DispatchFollowupResult, DispatchReadResult, OutboxEntry } from "./hub.js";
import { Ledger, type CommandOutcome, type DispatchRecord } from "./ledger.js";
import { PolicyStore, type DispatchPolicy, type DispatchSender, type MasterModelSelection } from "./policy.js";
import { TaskBlobStaging } from "./task-blobs.js";

const EXPLICIT_REASONING_OPTION_IDS = new Set(["thought_level", "effort", "reasoningEffort"]);

function hasExplicitReasoningOption(selection: MasterModelSelection | undefined): boolean {
  return Boolean(selection?.options?.some((item) => EXPLICIT_REASONING_OPTION_IDS.has(item.id)));
}

const TTL_MS = 60_000;
const POLL_MS = 15_000;
const ACTIVE_POLL_MS = 1_500;
const ACTIVE_THREAD_STATUSES = new Set(["preparing", "queued", "starting", "running"]);
const RETRY_MS = [60_000, 120_000, 300_000] as const;
const SUMMARY_LIMIT = 32_000;
/** 中转对单条 result 帧上限为 256 KB，这里预留外层封装与转义空间。 */
const TASK_RESULT_MAX_BYTES = 190 * 1024;
const UNLEDGERED_READ_KINDS = new Set<string>([
  "tasks.board",
  "tasks.review",
  "tasks.blob.put",
  "tasks.blob.get",
  "rd.open",
  "rd.ice",
  "rd.close",
]);
const BLOB_READ_DEFAULT_BYTES = 120 * 1024;
const BLOB_READ_MAX_BYTES = 140 * 1024;
const CLOSED = "本机没有开启接收派活";
const RD_CLOSED = "本机没有开放远程桌面";
const REJECTED = "本机不接受这条指令";

const MASTER_AGENT_BASE_LINES = [
  "你当前是运行在 U-Brain 主控设备上的常驻编排 Agent，正通过移动端与用户持续会话。",
  "你可以使用已挂载的 you-brain MCP 工具（list_devices、dispatch_to_device、get_dispatch_result、send_to_dispatch）查看在线设备、向其他设备的 T3 派发开发任务、查询进展与追问。",
  "回答设备状态、任务进展或编排咨询时直接简洁作答；除非用户明确要求查看本机代码仓库，否则不要扫描本机代码目录。",
  "派活时遵循：先确认目标设备与白名单项目；仅派白名单项目；结果如实汇报 dispatchId、生效权限和链接。",
];

export interface ThreadStatusEvent {
  dispatchId: string;
  kind: "thread.status";
  data: {
    threadId: string;
    status: string;
    previous: string | null;
    title: string;
    link: string | null;
  };
}

export interface AgentStatusEvent {
  dispatchId: string;
  kind: "agent.status";
  data: {
    sessionId: string;
    threadId: string | null;
    status: string;
    previous: string | null;
    title: string;
    link: string | null;
  };
}

export interface OutboxUpdatedEvent {
  dispatchId: string;
  kind: "outbox.updated";
  data: {
    dispatchId: string;
    status: string;
    title: string;
    deviceName: string;
    updatedAt: number;
    lastSummary?: string;
    error?: string;
    threadUrl?: string;
  };
}

export interface RdIceEmitEvent {
  dispatchId: string;
  kind: "rd.ice";
  data: {
    sessionId: string;
    candidates: RdIceCandidate[];
  };
}

export interface RdStateEmitEvent {
  dispatchId: string;
  kind: "rd.state";
  data: {
    sessionId: string;
    state: "ready" | "closed" | "error";
    displays?: RdDisplayInfo[];
    activeDisplayId?: number;
    permissions?: RdPermissions;
    error?: string;
  };
}

export type DispatchEmitEvent =
  | ThreadStatusEvent
  | AgentStatusEvent
  | OutboxUpdatedEvent
  | RdIceEmitEvent
  | RdStateEmitEvent;

export interface DispatchOutboxPort {
  list(): Promise<OutboxEntry[]>;
  followup(dispatchId: string, prompt: string): Promise<DispatchFollowupResult>;
  refresh(dispatchId: string): Promise<DispatchReadResult>;
}

export interface DispatchT3Port {
  projects(): Promise<Array<{ id: string; name: string; cwd: string }>>;
  launchThread(input: {
    projectId: string;
    title: string;
    prompt: string;
    requestId: string;
    runtimeMode: "auto-accept-edits" | "auto" | "full-access";
    maxMode?: RuntimeModeName;
    modelSelection?: MasterModelSelection;
    fastOrchestrator?: boolean;
  }): Promise<{ threadId: string; threadUrl: string }>;
  followup(threadId: string, prompt: string, commandId: string): Promise<void>;
  inspect(threadId: string): Promise<{ state: "planning" | "running" | "ready" | "failed"; summary: string; error?: string }>;
  threadStates(): Promise<T3ThreadBrief[]>;
  latestAnswer(threadId: string): Promise<string>;
  sendMessage?(threadId: string, message: string, requestId: string): Promise<string>;
  readMessages?(threadId: string, options?: { afterPosition?: number; limit?: number }): Promise<T3ThreadConversation>;
  defaultDispatchProject?(): Promise<{ id: string; name: string } | null>;
}

export interface DispatchExecutorDeviceSnapshot {
  id: string;
  name: string;
  online: boolean;
  self: boolean;
  acceptsDispatch: boolean;
  maxMode: string | null;
  projects: Array<{ id: string; name: string }>;
}

export type DispatchTasksPort = Pick<TaskHttpPort, "board" | "create" | "update" | "action" | "review"> &
  Partial<Pick<TaskHttpPort, "image">>;

export interface DispatchExecutorOptions {
  dataDir: string;
  deviceId: string;
  now?: () => number;
  t3: DispatchT3Port;
  tasksPort?: DispatchTasksPort;
  remoteDesktopPort?: RemoteDesktopPort;
  role?: "desktop" | "server";
  outboxPort?: DispatchOutboxPort;
  devicesPort?: () => Promise<DispatchExecutorDeviceSnapshot[]>;
  replyPort?: (replyToken: string, text: string) => Promise<{ ok: true; targetName: string } | { ok: false; error: string }>;
  emitEvent(to: string, frame: DispatchEmitEvent): void;
  notify?(info: { fromName: string; projectName: string; title: string }): void;
  /** 云盘里登记的入网设备（不含本机）；策略开了 trustEnrolled 时都算允许的发起设备。 */
  members?(): Promise<DispatchSender[]>;
}

class DispatchFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchFailure";
  }
}

function asLaunchMode(mode: RuntimeModeName): LaunchModeName | null {
  return mode === "approval-required" ? null : mode;
}

function failureMessage(error: unknown): string {
  if (error instanceof DispatchFailure || error instanceof T3AutomationError || error instanceof TaskError) {
    return error.message;
  }
  return "派活执行失败";
}

function frameFrom(frame: CmdFrame): string {
  return typeof frame?.from === "string" ? frame.from : "";
}

function frameKind(frame: CmdFrame): string {
  const kind = frame?.cmd?.kind;
  return typeof kind === "string" ? kind : "";
}

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path} ${issue.message}`;
  }).join("；");
}

/**
 * 目标端执行器。判定顺序：未开启 → 发送方与验签 → 过期 → nonce →
 * 相同 cmdId 直接返回 → kind 与参数 → 项目白名单 → 执行。
 * 拒绝文案不包含策略细节；审计只记原因，不记 prompt。
 */
export class DispatchExecutor {
  readonly #deviceId: string;
  readonly #now: () => number;
  readonly #t3: DispatchT3Port;
  readonly #tasks: DispatchTasksPort | undefined;
  readonly #remoteDesktop: RemoteDesktopPort | undefined;
  readonly #role: "desktop" | "server" | undefined;
  readonly #outbox: DispatchOutboxPort | undefined;
  readonly #devicesPort: DispatchExecutorOptions["devicesPort"];
  readonly #reply: DispatchExecutorOptions["replyPort"];
  readonly #emit: DispatchExecutorOptions["emitEvent"];
  readonly #notify: DispatchExecutorOptions["notify"];
  readonly #members: DispatchExecutorOptions["members"];
  readonly #policy: PolicyStore;
  readonly #ledger: Ledger;
  readonly #sessions: AgentSessionStore;
  readonly #audit: AuditLog;
  readonly #blobs: TaskBlobStaging;
  readonly #nonces = new Map<string, number>();
  #seen: Map<string, string> | null = null;
  /** 刚派出、还没被轮询看到过的会话：以 running 为起点，短任务在一个周期内做完也能发出状态变化。 */
  #launched = new Map<string, string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #failures = 0;

  constructor(options: DispatchExecutorOptions) {
    this.#deviceId = options.deviceId;
    this.#now = options.now ?? Date.now;
    this.#t3 = options.t3;
    this.#tasks = options.tasksPort;
    this.#remoteDesktop = options.remoteDesktopPort;
    this.#role = options.role;
    this.#outbox = options.outboxPort;
    this.#devicesPort = options.devicesPort;
    this.#reply = options.replyPort;
    this.#emit = options.emitEvent;
    this.#notify = options.notify;
    this.#members = options.members;
    this.#policy = new PolicyStore(options.dataDir);
    this.#ledger = new Ledger(options.dataDir, this.#now);
    this.#sessions = new AgentSessionStore(options.dataDir, this.#now);
    this.#audit = new AuditLog(options.dataDir);
    this.#blobs = new TaskBlobStaging(options.dataDir);

    this.#remoteDesktop?.setSignalingEvents({
      onIce: (to, sessionId, candidates) => {
        if (candidates.length === 0) return;
        try {
          this.#emit(to, {
            dispatchId: sessionId,
            kind: "rd.ice",
            data: { sessionId, candidates },
          });
        } catch {
          // 推送失败不影响会话
        }
      },
      onState: (to, sessionId, payload) => {
        try {
          this.#emit(to, {
            dispatchId: sessionId,
            kind: "rd.state",
            data: { sessionId, ...payload },
          });
        } catch {
          // 推送失败不影响会话
        }
      },
    });
  }

  agentSubscribers(): Promise<string[]> {
    return this.#sessions.subscribers();
  }

  policy(): Promise<DispatchPolicy> {
    return this.#policy.read();
  }

  async updatePolicy(patch: Partial<DispatchPolicy>): Promise<DispatchPolicy> {
    const next = await this.#policy.write(patch);
    if (!next.remoteDesktop && this.#remoteDesktop) {
      await this.#remoteDesktop.closeAll("本机已关闭远程桌面").catch(() => undefined);
    } else if (next.remoteDesktop && this.#remoteDesktop?.supported) {
      this.#remoteDesktop.warmup?.();
    }
    return next;
  }

  closeRemoteDesktop(reason?: string): void {
    if (!this.#remoteDesktop) return;
    void this.#remoteDesktop.closeAll(reason).catch(() => undefined);
  }

  /** 未开启、未允许、验签失败、过期、重放不写命令账本；执行成功和业务失败要写（只读大响应除外）。 */
  async handle(frame: CmdFrame): Promise<CommandOutcome> {
    const now = this.#now();
    const from = frameFrom(frame);
    const kind = frameKind(frame);
    const policy = await this.#policy.read();
    const isRemoteDesktop = kind === "rd.open" || kind === "rd.ice" || kind === "rd.close";
    if (isRemoteDesktop) {
      if (!policy.remoteDesktop || !this.#remoteDesktop?.supported || this.#role === "server") {
        return this.#reject(now, from, kind, "未开放远程桌面", RD_CLOSED);
      }
    } else if (!policy.enabled && kind !== "notice.reply") {
      return this.#reject(now, from, kind, "未开启", CLOSED);
    }

    const sender = await this.#sender(policy, from);
    if (!sender) return this.#reject(now, from, kind, "发送方未允许", REJECTED);
    if (!verifyCommand(sender.publicKey, frame)) return this.#reject(now, from, kind, "验签失败", REJECTED);
    if (frame.to !== this.#deviceId) return this.#reject(now, from, kind, "目标不是本机", REJECTED);
    if (typeof frame.ts !== "number" || !Number.isFinite(frame.ts) || Math.abs(now - frame.ts) > TTL_MS) {
      return this.#reject(now, from, kind, "指令过期", REJECTED);
    }
    if (typeof frame.nonce !== "string" || frame.nonce === "") return this.#reject(now, from, kind, "nonce 无效", REJECTED);
    if (this.#replay(from, frame.nonce, now)) return this.#reject(now, from, kind, "nonce 重放", REJECTED);

    const skipLedger = UNLEDGERED_READ_KINDS.has(kind);
    if (!skipLedger && typeof frame.cmdId === "string" && frame.cmdId !== "") {
      const cached = await this.#ledger.getCommand(frame.cmdId);
      if (cached) {
        await this.#audit.write({ ts: now, from, kind, outcome: "idempotent" });
        return cached.result;
      }
    }

    if (!(DISPATCH_KINDS as readonly string[]).includes(kind)) {
      await this.#audit.write({ ts: now, from, kind, outcome: "rejected", reason: "不支持的指令" });
      return { ok: false, error: `不支持的指令：${kind}` };
    }
    const parsed = DispatchCommandSchema.safeParse(frame.cmd);
    if (!parsed.success) {
      await this.#audit.write({ ts: now, from, kind, outcome: "rejected", reason: "参数不对" });
      return { ok: false, error: `参数不对：${formatIssues(parsed.error)}`.slice(0, 300) };
    }
    if (parsed.data.kind === "t3.start" && !policy.allProjects && !policy.allowedProjects.includes(parsed.data.args.projectId)) {
      return this.#reject(now, from, kind, "项目未允许", REJECTED);
    }

    try {
      const result = await this.#run(parsed.data, frame, policy, sender, now);
      if (!skipLedger) await this.#ledger.putCommand(frame.cmdId, { ok: true, result });
      await this.#audit.write({ ts: now, from, kind, outcome: "ok" });
      return { ok: true, result };
    } catch (error) {
      const message = failureMessage(error);
      if (!skipLedger) await this.#ledger.putCommand(frame.cmdId, { ok: false, error: message });
      await this.#audit.write({ ts: now, from, kind, outcome: "error", reason: "执行失败" });
      return { ok: false, error: message };
    }
  }

  /**
   * T3 隧道的授权：开放查看 → 发送方在允许名单且验签 → 目标是本机 → 未过期 → nonce 不重放。
   * 和接收派活（enabled）互相独立；只返回发送方，不执行任何 T3 操作。
   */
  async authorizeView(frame: CmdFrame): Promise<{ ok: true; sender: DispatchSender } | { ok: false; error: string }> {
    const now = this.#now();
    const from = frameFrom(frame);
    const kind = frameKind(frame);
    const policy = await this.#policy.read();
    const fail = async (reason: string, error = REJECTED): Promise<{ ok: false; error: string }> => {
      await this.#reject(now, from, kind, reason, error);
      return { ok: false, error };
    };
    if (!policy.viewT3) return fail("未开放 T3 查看", "本机没有开放 T3 查看");
    const sender = await this.#sender(policy, from);
    if (!sender) return fail("发送方未允许");
    if (!verifyCommand(sender.publicKey, frame)) return fail("验签失败");
    if (frame.to !== this.#deviceId) return fail("目标不是本机");
    if (typeof frame.ts !== "number" || !Number.isFinite(frame.ts) || Math.abs(now - frame.ts) > TTL_MS) return fail("指令过期");
    if (typeof frame.nonce !== "string" || frame.nonce === "") return fail("nonce 无效");
    if (this.#replay(from, frame.nonce, now)) return fail("nonce 重放");
    await this.#audit.write({ ts: now, from, kind, outcome: "ok" });
    return { ok: true, sender };
  }

  async hello(): Promise<HelloDispatch> {
    const policy = await this.#policy.read();
    const rolePart = this.#role ? { role: this.#role } : {};
    const remoteDesktop = Boolean(
      policy.remoteDesktop && this.#remoteDesktop?.supported && this.#role !== "server",
    );
    try {
      return {
        enabled: policy.enabled,
        t3: { ready: true },
        projects: await this.#visibleProjects(policy),
        maxMode: policy.maxMode,
        viewT3: policy.viewT3,
        remoteDesktop,
        ...rolePart,
      };
    } catch {
      return {
        enabled: policy.enabled,
        t3: { ready: false },
        projects: [],
        maxMode: policy.maxMode,
        viewT3: policy.viewT3,
        remoteDesktop,
        ...rolePart,
      };
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#schedule(0);
    if (this.#remoteDesktop?.supported) {
      void this.#policy
        .read()
        .then((policy) => {
          if (this.#started && policy.remoteDesktop) {
            this.#remoteDesktop?.warmup?.();
          }
        })
        .catch(() => undefined);
    }
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.closeRemoteDesktop("执行器已停止");
  }

  /** 读一次账本内会话的状态。第一次只建立基线；之后 status 变化才发 thread.status 或 agent.status。 */
  async tick(): Promise<void> {
    this.#timer = null;
    let next: number = POLL_MS;
    try {
      if (!(await this.#watchEnabled())) {
        this.#seen = null;
        return;
      }
      const threads = await this.#relevantThreads();
      this.#failures = 0;
      {
        for (const thread of threads) {
          const previous = this.#seen?.get(thread.threadId) ?? this.#launched.get(thread.threadId);
          if (previous === undefined || previous === thread.status) continue;
          const [hit, agentSession] = await Promise.all([
            this.#ledger.findByThread(thread.threadId),
            this.#sessions.findByThread(thread.threadId),
          ]);
          if (agentSession) {
            const subscribers = await this.#sessions.subscribers();
            const targets = new Set(subscribers);
            if (hit?.from) targets.add(hit.from);
            for (const target of targets) {
              try {
                this.#emit(target, {
                  dispatchId: agentSession.sessionId,
                  kind: "agent.status",
                  data: {
                    sessionId: agentSession.sessionId,
                    threadId: thread.threadId,
                    status: thread.status,
                    previous,
                    title: thread.title,
                    link: thread.link,
                  },
                });
              } catch {
                // 推送失败不影响监视。
              }
            }
            continue;
          }
          if (!hit) continue;
          try {
            this.#emit(hit.from, {
              dispatchId: hit.dispatchId,
              kind: "thread.status",
              data: {
                threadId: thread.threadId,
                status: thread.status,
                previous,
                title: thread.title,
                link: thread.link,
              },
            });
          } catch {
            // 推送失败不影响监视。
          }
        }
      }
      this.#seen = new Map(threads.map((thread) => [thread.threadId, thread.status]));
      for (const thread of threads) this.#launched.delete(thread.threadId);
      if (this.#launched.size > 0 || threads.some((thread) => ACTIVE_THREAD_STATUSES.has(thread.status))) {
        next = ACTIVE_POLL_MS;
      }
    } catch {
      next = RETRY_MS[Math.min(this.#failures, RETRY_MS.length - 1)] ?? POLL_MS;
      this.#failures += 1;
    } finally {
      this.#schedule(next);
    }
  }

  async #run(command: DispatchCommand, frame: CmdFrame, policy: DispatchPolicy, sender: DispatchSender, now: number): Promise<unknown> {
    switch (command.kind) {
      case "t3.projects":
        return { projects: await this.#visibleProjects(policy) };
      case "t3.start":
        return this.#start(command.args, frame, policy, sender, now);
      case "t3.followup":
        return this.#followup(command.args.threadId, command.args.prompt, command.args.requestId);
      case "t3.read":
        return this.#read(command.args.threadId);
      case "t3.threads":
        return { threads: await this.#threads() };
      case "agent.session":
        return this.#agentSession(command.args, frame, policy);
      case "agent.send":
        return this.#agentSend(command.args, frame, policy, now);
      case "agent.read":
        return this.#agentRead(command.args, frame);
      case "dispatch.list":
        return { entries: this.#outbox ? await this.#outbox.list() : [] };
      case "dispatch.followup":
        return this.#dispatchFollowup(command.args.dispatchId, command.args.prompt);
      case "dispatch.refresh":
        return this.#dispatchRefresh(command.args.dispatchId);
      case "notice.reply":
        return this.#noticeReply(command.args.replyToken, command.args.text);
      case "tasks.board":
        return this.#tasksBoard(policy);
      case "tasks.create":
        return this.#tasksCreate(command.args, frame.from, policy, now);
      case "tasks.update":
        return this.#tasksUpdate(command.args, frame.from, policy, now);
      case "tasks.action":
        return this.#tasksAction(command.args, policy);
      case "tasks.review":
        return this.#tasksReview(command.args.id, policy);
      case "tasks.blob.put":
        return this.#tasksBlobPut(command.args, frame.from, now);
      case "tasks.blob.get":
        return this.#tasksBlobGet(command.args, policy);
      case "rd.open":
        return this.#rdCall(() => this.#remoteDesktop!.openSession(frame.from, command.args));
      case "rd.ice":
        return this.#rdCall(() => this.#remoteDesktop!.addIceCandidates(frame.from, command.args));
      case "rd.close":
        return this.#rdCall(() => this.#remoteDesktop!.closeSession(frame.from, command.args));
      default: {
        const unreachable: never = command;
        return unreachable;
      }
    }
  }

  async #rdCall<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.#remoteDesktop?.supported) throw new DispatchFailure(RD_CLOSED);
    try {
      return await fn();
    } catch (error) {
      throw new DispatchFailure(error instanceof Error ? error.message : "远程桌面会话操作失败");
    }
  }

  async #start(
    args: Extract<DispatchCommand, { kind: "t3.start" }>["args"],
    frame: CmdFrame,
    policy: DispatchPolicy,
    sender: DispatchSender,
    now: number,
  ): Promise<unknown> {
    const requested = args.mode ?? "auto";
    const effective = asLaunchMode(minMode(requested, policy.maxMode));
    if (!effective) throw new DispatchFailure("参数不对：权限模式不可用");
    const capped = effective !== requested;
    const existing = await this.#ledger.getDispatch(args.dispatchId);
    if (existing) return this.#startResult(existing);
    const launched = await this.#t3.launchThread({
      projectId: args.projectId,
      title: args.title,
      prompt: args.prompt,
      requestId: args.dispatchId,
      runtimeMode: effective,
      maxMode: policy.maxMode,
    });
    const record: DispatchRecord = {
      threadId: launched.threadId,
      from: frame.from,
      projectId: args.projectId,
      title: args.title,
      createdAt: now,
      threadUrl: launched.threadUrl,
      mode: effective,
      capped,
    };
    await this.#ledger.putDispatch(args.dispatchId, record);
    this.#launched.set(launched.threadId, "running");
    this.#rescheduleSoon(800);
    await this.#notifyStart(policy, sender.name, args.projectId, args.title);
    return this.#startResult(record);
  }

  #startResult(record: DispatchRecord): { threadId: string; threadUrl: string; mode: LaunchModeName; capped: boolean } {
    return { threadId: record.threadId, threadUrl: record.threadUrl, mode: record.mode, capped: record.capped };
  }

  async #notifyStart(policy: DispatchPolicy, fromName: string, projectId: string, title: string): Promise<void> {
    if (!policy.notify || !this.#notify) return;
    let projectName = projectId;
    try {
      const projects = await this.#t3.projects();
      projectName = projects.find((item) => item.id === projectId)?.name ?? projectId;
    } catch {
      // 项目名查不到时用 id，不让通知失败影响派活。
    }
    try {
      this.#notify({ fromName, projectName, title });
    } catch {
      // 通知失败不影响派活结果。
    }
  }

  async #followup(threadId: string, prompt: string, requestId: string): Promise<Record<string, never>> {
    if (!(await this.#ledger.findByThread(threadId))) throw new DispatchFailure("找不到这个派活会话");
    await this.#t3.followup(threadId, prompt, requestId);
    return {};
  }

  async #read(threadId: string): Promise<{ state: "planning" | "running" | "ready" | "failed"; summary: string; error?: string; link: string | null }> {
    if (!(await this.#ledger.findByThread(threadId))) throw new DispatchFailure("找不到这个派活会话");
    const inspected = await this.#t3.inspect(threadId);
    const brief = (await this.#t3.threadStates()).find((item) => item.threadId === threadId);
    const result: { state: "planning" | "running" | "ready" | "failed"; summary: string; error?: string; link: string | null } = {
      state: inspected.state,
      summary: inspected.summary.slice(0, SUMMARY_LIMIT),
      link: brief?.link ?? null,
    };
    if (typeof inspected.error === "string" && inspected.error !== "") result.error = inspected.error;
    return result;
  }

  async #threads(): Promise<Array<{ threadId: string; title: string; status: string; link: string | null; dispatchId: string }>> {
    const entries = await this.#ledger.listDispatches();
    if (entries.length === 0) return [];
    const states = await this.#t3.threadStates();
    return entries.map((entry) => {
      const brief = states.find((item) => item.threadId === entry.threadId);
      return {
        threadId: entry.threadId,
        title: brief ? brief.title : entry.title,
        status: brief ? brief.status : "unknown",
        link: brief ? brief.link : null,
        dispatchId: entry.dispatchId,
      };
    });
  }

  async #visibleProjects(policy: DispatchPolicy): Promise<Array<{ id: string; name: string }>> {
    const allow = new Set(policy.allowedProjects);
    const projects = await this.#t3.projects();
    return projects
      .filter((project) => policy.allProjects || allow.has(project.id))
      .map((project) => ({ id: project.id, name: project.name }));
  }

  async #resolveDefaultProject(policy: DispatchPolicy): Promise<{ id: string; name: string } | null> {
    const visible = await this.#visibleProjects(policy);
    if (visible.length === 0) return null;
    if (policy.masterProjectId) {
      const pinned = visible.find((item) => item.id === policy.masterProjectId);
      if (pinned) return pinned;
    }
    const preferred = await this.#t3.defaultDispatchProject?.().catch(() => null);
    if (preferred && visible.some((item) => item.id === preferred.id)) return preferred;
    return visible[0]!;
  }

  async #buildMasterPreamble(): Promise<string> {
    const [devices, outboxAll] = await Promise.all([
      this.#devicesPort ? this.#devicesPort().catch(() => [] as DispatchExecutorDeviceSnapshot[]) : Promise.resolve([] as DispatchExecutorDeviceSnapshot[]),
      this.#outbox ? this.#outbox.list().catch(() => [] as OutboxEntry[]) : Promise.resolve([] as OutboxEntry[]),
    ]);
    const lines: string[] = [MASTER_AGENT_PREAMBLE_START, ...MASTER_AGENT_BASE_LINES];
    if (devices.length > 0 || outboxAll.length > 0) {
      const snapshot = {
        devices,
        recentOutbox: outboxAll.slice(0, 10).map((entry) => ({
          dispatchId: entry.dispatchId,
          to: entry.to,
          deviceName: entry.deviceName,
          projectId: entry.projectId,
          title: entry.title,
          status: entry.status,
          mode: entry.mode,
          updatedAt: entry.updatedAt,
          ...(entry.lastSummary ? { lastSummary: entry.lastSummary.slice(0, 300) } : {}),
        })),
        note: "以上为会话启动时的实时快照；若需最新状态或后续变动可调用 list_devices / get_dispatch_result。",
      };
      lines.push(`当前跨设备实况快照（JSON）：${JSON.stringify(snapshot)}`);
    }
    lines.push(MASTER_AGENT_PREAMBLE_END);
    return lines.join("\n");
  }

  async #agentSession(
    args: Extract<DispatchCommand, { kind: "agent.session" }>["args"],
    frame: CmdFrame,
    policy: DispatchPolicy,
  ): Promise<unknown> {
    await this.#sessions.addSubscriber(frame.from);
    let ensured;
    try {
      ensured = await this.#sessions.ensureSession({
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
        ...(args.create !== undefined ? { create: args.create } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
      });
    } catch (error) {
      throw new DispatchFailure(error instanceof Error ? error.message : "无法获取主控会话");
    }
    const [states, defaultProject, conversation] = await Promise.all([
      this.#t3.threadStates().catch(() => [] as T3ThreadBrief[]),
      this.#resolveDefaultProject(policy).catch(() => null),
      this.#agentRead({ sessionId: ensured.session.sessionId, limit: 60 }, frame).catch(() => null),
    ]);
    const sessions = ensured.state.sessions.map((item) => ({
      ...item,
      status: item.threadId ? (states.find((t) => t.threadId === item.threadId)?.status ?? "idle") : "draft",
    }));
    return {
      activeSessionId: ensured.session.sessionId,
      sessions,
      defaultProject,
      ...(conversation ? { conversation } : {}),
    };
  }

  async #agentSend(
    args: Extract<DispatchCommand, { kind: "agent.send" }>["args"],
    frame: CmdFrame,
    policy: DispatchPolicy,
    now: number,
  ): Promise<unknown> {
    await this.#sessions.addSubscriber(frame.from);
    const requested = args.mode ?? "auto";
    const effective = asLaunchMode(minMode(requested, policy.maxMode));
    if (!effective) throw new DispatchFailure("参数不对：权限模式不可用");
    const capped = effective !== requested;

    let ensured;
    try {
      ensured = await this.#sessions.ensureSession({
        ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
      });
    } catch (error) {
      throw new DispatchFailure(error instanceof Error ? error.message : "找不到这个主控会话");
    }
    const session = ensured.session;

    if (!session.threadId) {
      let projectId = args.projectId;
      if (projectId !== undefined) {
        if (!policy.allProjects && !policy.allowedProjects.includes(projectId)) {
          throw new DispatchFailure("项目未允许");
        }
      } else {
        projectId = (await this.#resolveDefaultProject(policy))?.id;
      }
      if (!projectId) {
        throw new DispatchFailure("本机 T3 还没有可用项目，请先在 T3 打开或创建一个项目");
      }
      const title =
        args.title?.trim() ||
        (session.title !== "主控会话" ? session.title : args.text.trim().slice(0, 36) || "主控会话");
      const preamble = await this.#buildMasterPreamble();
      const modelSelection = policy.masterModelSelection;
      const launched = await this.#t3.launchThread({
        projectId,
        title,
        prompt: `${preamble}\n\n${args.text}`,
        requestId: args.requestId,
        runtimeMode: effective,
        maxMode: policy.maxMode,
        ...(modelSelection ? { modelSelection } : {}),
        fastOrchestrator: !hasExplicitReasoningOption(modelSelection),
      });
      await this.#sessions.bindThread(session.sessionId, {
        threadId: launched.threadId,
        threadUrl: launched.threadUrl,
        projectId,
        title,
      });
      await this.#ledger.putDispatch(session.sessionId, {
        threadId: launched.threadId,
        from: frame.from,
        projectId,
        title,
        createdAt: now,
        threadUrl: launched.threadUrl,
        mode: effective,
        capped,
      });
      this.#launched.set(launched.threadId, "running");
      this.#rescheduleSoon(800);
      return {
        sessionId: session.sessionId,
        threadId: launched.threadId,
        threadUrl: launched.threadUrl,
        delivery: "started",
        mode: effective,
        capped,
      };
    }

    if (!this.#t3.sendMessage) {
      throw new DispatchFailure("当前 T3 适配器不支持追加消息");
    }
    const delivery = await this.#t3.sendMessage(session.threadId, args.text, args.requestId);
    await this.#sessions.touch(session.sessionId);
    this.#launched.set(session.threadId, "running");
    this.#rescheduleSoon(800);
    return {
      sessionId: session.sessionId,
      threadId: session.threadId,
      threadUrl: session.threadUrl ?? "",
      delivery,
      mode: effective,
      capped,
    };
  }

  async #agentRead(
    args: Extract<DispatchCommand, { kind: "agent.read" }>["args"],
    frame: CmdFrame,
  ): Promise<{
    sessionId: string | null;
    title: string;
    threadId: string | null;
    threadUrl: string | null;
    state: "idle" | "running" | "waiting" | "ready" | "failed";
    activity: string | null;
    messages: Array<{ position: number; role: "user" | "assistant"; text: string; runId: string | null }>;
    outbox: OutboxEntry[];
  }> {
    await this.#sessions.addSubscriber(frame.from);
    const [state, outboxAll] = await Promise.all([
      this.#sessions.read(),
      this.#outbox ? this.#outbox.list() : Promise.resolve([] as OutboxEntry[]),
    ]);
    const outbox = outboxAll.slice(0, 30);
    const targetId = args.sessionId ?? state.activeSessionId;
    const session = targetId ? (state.sessions.find((item) => item.sessionId === targetId) ?? null) : null;
    if (!session) {
      return {
        sessionId: null,
        title: "主控会话",
        threadId: null,
        threadUrl: null,
        state: "idle",
        activity: null,
        messages: [],
        outbox,
      };
    }
    if (!session.threadId) {
      return {
        sessionId: session.sessionId,
        title: session.title,
        threadId: null,
        threadUrl: null,
        state: "idle",
        activity: null,
        messages: [],
        outbox,
      };
    }
    if (!this.#t3.readMessages) {
      throw new DispatchFailure("当前 T3 适配器不支持读取对话内容");
    }
    const conversation = await this.#t3.readMessages(session.threadId, {
      ...(args.afterPosition !== undefined ? { afterPosition: args.afterPosition } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    return {
      sessionId: session.sessionId,
      title: session.title,
      threadId: session.threadId,
      threadUrl: conversation.threadUrl ?? session.threadUrl,
      state: conversation.state,
      activity: conversation.activity ?? null,
      messages: conversation.messages,
      outbox,
    };
  }

  async #dispatchFollowup(dispatchId: string, prompt: string): Promise<DispatchFollowupResult> {
    if (!this.#outbox) throw new DispatchFailure("本机未启用派活中枢");
    return this.#outbox.followup(dispatchId, prompt);
  }

  async #dispatchRefresh(dispatchId: string): Promise<DispatchReadResult> {
    if (!this.#outbox) throw new DispatchFailure("本机未启用派活中枢");
    return this.#outbox.refresh(dispatchId);
  }

  async #noticeReply(replyToken: string, text: string): Promise<{ ok: true; targetName: string }> {
    if (!this.#reply) throw new DispatchFailure("本机不支持移动端快捷回复");
    const result = await this.#reply(replyToken, text);
    if (!result.ok) throw new DispatchFailure(result.error);
    return result;
  }

  #requireTasks(): DispatchTasksPort {
    if (!this.#tasks) throw new DispatchFailure("本机暂不支持远程管理 TODO");
    return this.#tasks;
  }

  #assertProjectAllowed(policy: DispatchPolicy, projectId: string | null | undefined, newProject: unknown): void {
    if (policy.allProjects) return;
    if (newProject !== undefined) throw new DispatchFailure(REJECTED);
    if (typeof projectId === "string" && projectId !== "" && !policy.allowedProjects.includes(projectId)) {
      throw new DispatchFailure(REJECTED);
    }
  }

  async #assertExistingTaskAllowed(tasks: DispatchTasksPort, policy: DispatchPolicy, id: string): Promise<void> {
    if (policy.allProjects) return;
    const board = await tasks.board();
    const task = board.tasks.find((item) => item.id === id);
    if (task && task.projectId !== null && !policy.allowedProjects.includes(task.projectId)) {
      throw new DispatchFailure(REJECTED);
    }
  }

  #presentTaskBoard(board: TaskBoard, policy: DispatchPolicy): TaskBoard {
    const allowed = policy.allProjects ? null : new Set(policy.allowedProjects);
    const filtered: TaskBoard = {
      projects: allowed ? board.projects.filter((project) => allowed.has(project.id)) : structuredClone(board.projects),
      tasks: allowed
        ? board.tasks.filter((task) => task.projectId === null || allowed.has(task.projectId)).map((task) => structuredClone(task))
        : structuredClone(board.tasks),
      connectionError: board.connectionError,
    };
    return compactTaskBoard(filtered);
  }

  async #tasksBoard(policy: DispatchPolicy): Promise<TaskBoard> {
    const tasks = this.#requireTasks();
    return this.#presentTaskBoard(await tasks.board(), policy);
  }

  async #tasksCreate(
    args: Extract<DispatchCommand, { kind: "tasks.create" }>["args"],
    from: string,
    policy: DispatchPolicy,
    now: number,
  ): Promise<TaskBoard> {
    const tasks = this.#requireTasks();
    this.#assertProjectAllowed(policy, args.projectId, args.newProject);
    const { uploadIds, ...input } = args;
    const files = uploadIds && uploadIds.length > 0 ? await this.#consumeTaskBlobs(from, uploadIds, now) : undefined;
    const board = await tasks.create(input, files);
    return this.#presentTaskBoard(board, policy);
  }

  async #tasksUpdate(
    args: Extract<DispatchCommand, { kind: "tasks.update" }>["args"],
    from: string,
    policy: DispatchPolicy,
    now: number,
  ): Promise<TaskBoard> {
    const tasks = this.#requireTasks();
    this.#assertProjectAllowed(policy, args.projectId, args.newProject);
    await this.#assertExistingTaskAllowed(tasks, policy, args.id);
    const { uploadIds, ...input } = args;
    const files = uploadIds && uploadIds.length > 0 ? await this.#consumeTaskBlobs(from, uploadIds, now) : undefined;
    const board = await tasks.update(input, files);
    return this.#presentTaskBoard(board, policy);
  }

  async #tasksBlobPut(
    args: Extract<DispatchCommand, { kind: "tasks.blob.put" }>["args"],
    from: string,
    now: number,
  ): Promise<{ uploadId: string; receivedBytes: number; ready: boolean }> {
    this.#requireTasks();
    try {
      return await this.#blobs.put(from, args, now);
    } catch (error) {
      throw new DispatchFailure(error instanceof Error ? error.message : "附件上传失败");
    }
  }

  async #consumeTaskBlobs(from: string, uploadIds: readonly string[], now: number): Promise<File[]> {
    try {
      return await this.#blobs.consume(from, uploadIds, now);
    } catch (error) {
      throw new DispatchFailure(error instanceof Error ? error.message : "附件读取失败");
    }
  }

  async #tasksBlobGet(
    args: Extract<DispatchCommand, { kind: "tasks.blob.get" }>["args"],
    policy: DispatchPolicy,
  ): Promise<{
    name: string;
    mimeType: string;
    kind: "image" | "file";
    sizeBytes: number;
    offset: number;
    chunk: string;
    eof: boolean;
  }> {
    const tasks = this.#requireTasks();
    if (!tasks.image) throw new DispatchFailure("本机暂不支持远程读取 TODO 附件");
    await this.#assertExistingTaskAllowed(tasks, policy, args.taskId);
    const attachment = await tasks.image(args.taskId, args.imageId);
    const total = attachment.bytes.byteLength;
    const offset = Math.min(args.offset ?? 0, total);
    const length = Math.min(args.length ?? BLOB_READ_DEFAULT_BYTES, BLOB_READ_MAX_BYTES);
    const end = Math.min(offset + length, total);
    const slice = Buffer.from(attachment.bytes.subarray(offset, end));
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: isTaskImageAttachment(attachment) ? "image" : "file",
      sizeBytes: attachment.sizeBytes,
      offset,
      chunk: slice.toString("base64"),
      eof: end >= total,
    };
  }

  async #tasksAction(args: Extract<DispatchCommand, { kind: "tasks.action" }>["args"], policy: DispatchPolicy): Promise<TaskBoard> {
    const tasks = this.#requireTasks();
    if (args.action === "project") {
      this.#assertProjectAllowed(policy, args.projectId, undefined);
    } else {
      await this.#assertExistingTaskAllowed(tasks, policy, args.id);
    }
    const board = await tasks.action(args);
    return this.#presentTaskBoard(board, policy);
  }

  async #tasksReview(id: string, policy: DispatchPolicy): Promise<TaskReview> {
    const tasks = this.#requireTasks();
    await this.#assertExistingTaskAllowed(tasks, policy, id);
    const review = await tasks.review(id);
    return compactTaskReview(review);
  }

  /** 手动名单优先；开了 trustEnrolled 再查云盘成员（公钥来自云盘，不来自中转）。 */
  async #sender(policy: DispatchPolicy, from: string): Promise<DispatchSender | undefined> {
    const listed = policy.allowedSenders.find((item) => item.deviceId === from);
    if (listed || !policy.trustEnrolled || !this.#members || from === this.#deviceId) return listed;
    const members = await this.#members().catch(() => []);
    return members.find((item) => item.deviceId === from);
  }

  async #watchEnabled(): Promise<boolean> {
    const policy = await this.#policy.read();
    if (!policy.enabled) return false;
    if ((await this.#ledger.threadIds()).length > 0) return true;
    const state = await this.#sessions.read();
    return state.sessions.some((item) => item.threadId !== null);
  }

  async #relevantThreads(): Promise<T3ThreadBrief[]> {
    const ids = new Set(await this.#ledger.threadIds());
    const state = await this.#sessions.read();
    for (const item of state.sessions) {
      if (item.threadId !== null) ids.add(item.threadId);
    }
    return (await this.#t3.threadStates()).filter((thread) => ids.has(thread.threadId));
  }

  /** 窗口内见过的 (from, nonce) 视为重放。过期项顺手清掉。 */
  #replay(from: string, nonce: string, now: number): boolean {
    for (const [key, seenAt] of this.#nonces) {
      if (now - seenAt > TTL_MS) this.#nonces.delete(key);
    }
    const key = `${from}\0${nonce}`;
    if (this.#nonces.has(key)) return true;
    this.#nonces.set(key, now);
    return false;
  }

  async #reject(ts: number, from: string, kind: string, reason: string, error: string): Promise<CommandOutcome> {
    await this.#audit.write({ ts, from, kind, outcome: "rejected", reason });
    return { ok: false, error };
  }

  #rescheduleSoon(ms: number): void {
    if (!this.#started) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#schedule(ms);
  }

  #schedule(ms: number): void {
    if (!this.#started) return;
    this.#timer = setTimeout(() => void this.tick(), ms);
    (this.#timer as { unref?: () => void }).unref?.();
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function trimString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function compactTaskBoard(board: TaskBoard): TaskBoard {
  if (jsonBytes(board) <= TASK_RESULT_MAX_BYTES) return board;
  const copy = structuredClone(board);
  for (const task of copy.tasks) {
    if (task.run && task.run.summary.length > 600) {
      task.run.summary = trimString(task.run.summary, 600);
    }
  }
  if (jsonBytes(copy) <= TASK_RESULT_MAX_BYTES) return copy;
  for (const task of copy.tasks) {
    if (task.status === "done" && task.description.length > 400) {
      task.description = trimString(task.description, 400);
    }
  }
  if (jsonBytes(copy) <= TASK_RESULT_MAX_BYTES) return copy;
  const doneIndices = copy.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.status === "done")
    .sort((a, b) => a.task.updatedAt.localeCompare(b.task.updatedAt));
  const drop = new Set<number>();
  for (const item of doneIndices) {
    drop.add(item.index);
    const candidate = { ...copy, tasks: copy.tasks.filter((_, idx) => !drop.has(idx)) };
    if (jsonBytes(candidate) <= TASK_RESULT_MAX_BYTES) return candidate;
  }
  return { ...copy, tasks: copy.tasks.filter((_, idx) => !drop.has(idx)) };
}

function compactTaskReview(review: TaskReview): TaskReview {
  if (jsonBytes(review) <= TASK_RESULT_MAX_BYTES) return review;
  const copy = structuredClone(review);
  if (copy.task.run && copy.task.run.summary.length > 8_000) {
    copy.task.run.summary = trimString(copy.task.run.summary, 8_000);
  }
  if (copy.stat.length > 16_000) {
    copy.stat = trimString(copy.stat, 16_000);
  }
  if (jsonBytes(copy) <= TASK_RESULT_MAX_BYTES) return copy;
  let low = 0;
  let high = copy.diff.length;
  const baseDiff = copy.diff;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    copy.diff = baseDiff.slice(0, mid);
    copy.truncated = true;
    if (jsonBytes(copy) <= TASK_RESULT_MAX_BYTES) low = mid;
    else high = mid - 1;
  }
  copy.diff = baseDiff.slice(0, low);
  copy.truncated = true;
  return copy;
}

