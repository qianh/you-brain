import {
  DISPATCH_KINDS,
  DispatchCommandSchema,
  minMode,
  verifyCommand,
  type CmdFrame,
  type DispatchCommand,
  type HelloDispatch,
  type LaunchModeName,
  type RuntimeModeName,
} from "@you-brain/protocol";

import { T3AutomationError, type T3ThreadBrief } from "../deck/t3/automation.js";
import { AuditLog } from "./audit.js";
import { Ledger, type CommandOutcome, type DispatchRecord } from "./ledger.js";
import { PolicyStore, type DispatchPolicy, type DispatchSender } from "./policy.js";

const TTL_MS = 60_000;
const POLL_MS = 15_000;
const RETRY_MS = [60_000, 120_000, 300_000] as const;
const SUMMARY_LIMIT = 32_000;
const CLOSED = "本机没有开启接收派活";
const REJECTED = "本机不接受这条指令";

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

export interface DispatchT3Port {
  projects(): Promise<Array<{ id: string; name: string; cwd: string }>>;
  launchThread(input: {
    projectId: string;
    title: string;
    prompt: string;
    requestId: string;
    runtimeMode: "auto-accept-edits" | "auto" | "full-access";
  }): Promise<{ threadId: string; threadUrl: string }>;
  followup(threadId: string, prompt: string, commandId: string): Promise<void>;
  inspect(threadId: string): Promise<{ state: "planning" | "running" | "ready" | "failed"; summary: string; error?: string }>;
  threadStates(): Promise<T3ThreadBrief[]>;
  latestAnswer(threadId: string): Promise<string>;
}

export interface DispatchExecutorOptions {
  dataDir: string;
  deviceId: string;
  now?: () => number;
  t3: DispatchT3Port;
  emitEvent(to: string, frame: ThreadStatusEvent): void;
  notify?(info: { fromName: string; projectName: string; title: string }): void;
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
  if (error instanceof DispatchFailure || error instanceof T3AutomationError) return error.message;
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
  readonly #emit: DispatchExecutorOptions["emitEvent"];
  readonly #notify: DispatchExecutorOptions["notify"];
  readonly #policy: PolicyStore;
  readonly #ledger: Ledger;
  readonly #audit: AuditLog;
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
    this.#emit = options.emitEvent;
    this.#notify = options.notify;
    this.#policy = new PolicyStore(options.dataDir);
    this.#ledger = new Ledger(options.dataDir, this.#now);
    this.#audit = new AuditLog(options.dataDir);
  }

  policy(): Promise<DispatchPolicy> {
    return this.#policy.read();
  }

  updatePolicy(patch: Partial<DispatchPolicy>): Promise<DispatchPolicy> {
    return this.#policy.write(patch);
  }

  /** 未开启、未允许、验签失败、过期、重放不写命令账本；执行成功和业务失败要写。 */
  async handle(frame: CmdFrame): Promise<CommandOutcome> {
    const now = this.#now();
    const from = frameFrom(frame);
    const kind = frameKind(frame);
    const policy = await this.#policy.read();
    if (!policy.enabled) return this.#reject(now, from, kind, "未开启", CLOSED);

    const sender = policy.allowedSenders.find((item) => item.deviceId === from);
    if (!sender) return this.#reject(now, from, kind, "发送方未允许", REJECTED);
    if (!verifyCommand(sender.publicKey, frame)) return this.#reject(now, from, kind, "验签失败", REJECTED);
    if (frame.to !== this.#deviceId) return this.#reject(now, from, kind, "目标不是本机", REJECTED);
    if (typeof frame.ts !== "number" || !Number.isFinite(frame.ts) || Math.abs(now - frame.ts) > TTL_MS) {
      return this.#reject(now, from, kind, "指令过期", REJECTED);
    }
    if (typeof frame.nonce !== "string" || frame.nonce === "") return this.#reject(now, from, kind, "nonce 无效", REJECTED);
    if (this.#replay(from, frame.nonce, now)) return this.#reject(now, from, kind, "nonce 重放", REJECTED);

    if (typeof frame.cmdId === "string" && frame.cmdId !== "") {
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
    if (parsed.data.kind === "t3.start" && !policy.allowedProjects.includes(parsed.data.args.projectId)) {
      return this.#reject(now, from, kind, "项目未允许", REJECTED);
    }

    try {
      const result = await this.#run(parsed.data, frame, policy, sender, now);
      await this.#ledger.putCommand(frame.cmdId, { ok: true, result });
      await this.#audit.write({ ts: now, from, kind, outcome: "ok" });
      return { ok: true, result };
    } catch (error) {
      const message = failureMessage(error);
      await this.#ledger.putCommand(frame.cmdId, { ok: false, error: message });
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
    const sender = policy.allowedSenders.find((item) => item.deviceId === from);
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
    try {
      return {
        enabled: policy.enabled,
        t3: { ready: true },
        projects: await this.#visibleProjects(policy.allowedProjects),
        maxMode: policy.maxMode,
        viewT3: policy.viewT3,
      };
    } catch {
      return { enabled: policy.enabled, t3: { ready: false }, projects: [], maxMode: policy.maxMode, viewT3: policy.viewT3 };
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#schedule(0);
  }

  stop(): void {
    this.#started = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** 读一次账本内会话的状态。第一次只建立基线；之后 status 变化才发 thread.status。 */
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
          const hit = await this.#ledger.findByThread(thread.threadId);
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
        return { projects: await this.#visibleProjects(policy.allowedProjects) };
      case "t3.start":
        return this.#start(command.args, frame, policy, sender, now);
      case "t3.followup":
        return this.#followup(command.args.threadId, command.args.prompt, command.args.requestId);
      case "t3.read":
        return this.#read(command.args.threadId);
      case "t3.threads":
        return { threads: await this.#threads() };
      default: {
        const unreachable: never = command;
        return unreachable;
      }
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

  async #visibleProjects(allowed: readonly string[]): Promise<Array<{ id: string; name: string }>> {
    const allow = new Set(allowed);
    const projects = await this.#t3.projects();
    return projects.filter((project) => allow.has(project.id)).map((project) => ({ id: project.id, name: project.name }));
  }

  async #watchEnabled(): Promise<boolean> {
    const policy = await this.#policy.read();
    return policy.enabled && (await this.#ledger.threadIds()).length > 0;
  }

  async #relevantThreads(): Promise<T3ThreadBrief[]> {
    const ids = new Set(await this.#ledger.threadIds());
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

  #schedule(ms: number): void {
    if (!this.#started) return;
    this.#timer = setTimeout(() => void this.tick(), ms);
    (this.#timer as { unref?: () => void }).unref?.();
  }
}
