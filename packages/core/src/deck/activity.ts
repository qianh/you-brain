import type { Tty7AgentStatus, Tty7SessionsView } from "./tty7.js";

/**
 * 终端「是否在执行」的通用判断：不依赖 agent hooks，所有 AI CLI 和普通脚本都适用。
 * 数据来自 `tty7 procs`（进程树、前台进程、是否停在 shell 提示符、每个进程的累计 CPU 时间）。
 *
 * - 普通脚本（会话里没有识别出 agent）：前台有非 shell 进程且没回到提示符 = 执行中，回到提示符 = 结束。
 * - AI CLI（识别出 agent）：它停在输入框时也一直在前台，所以改看进程树的 CPU 时间有没有在涨；
 *   停涨超过 QUIET_MS 才算结束（模型思考、等网络时 CPU 会短暂不涨）。
 * - 有 hooks 状态的会话不在这里判断（hooks 更准，能区分「等你」和「已完成」）。
 *
 * 产出的状态只有 working 和 done：
 * - 连续执行 WORKING_MIN_MS 以上才显示 working（`ls` 这种瞬间命令不闪）。
 * - 执行 DONE_MIN_MS 以上才在结束时给 done（短命令不提醒），done 保留 DONE_TTL_MS。
 */
export const ACTIVITY_INTERVAL_MS = 3_000;
const WORKING_MIN_MS = 3_000;
const DONE_MIN_MS = 10_000;
const DONE_TTL_MS = 120_000;
/** AI CLI：CPU 停涨多久才算结束。 */
const QUIET_MS = 8_000;
/** AI CLI：一次采样间隔内进程树 CPU 增加超过这个值才算「在干活」（空闲实测约 6ms / 2s）。 */
const CPU_ACTIVE_NS = 40_000_000;

export interface ActivityProc {
  pid: number;
  /** 0 是会话里的 shell 本身。 */
  depth: number;
  foreground: boolean;
  cpuNs: number;
}

export interface ActivityInput {
  /** 会话里识别出了 AI CLI。 */
  agent: boolean;
  atPrompt: boolean;
  procs: readonly ActivityProc[];
}

interface PaneState {
  cpu: Map<number, number>;
  initialized: boolean;
  active: boolean;
  activeSince: number;
  lastRawAt: number;
  doneUntil: number;
}

export class ActivityTracker {
  readonly #panes = new Map<number, PaneState>();

  observe(pane: number, input: ActivityInput, now: number): void {
    let state = this.#panes.get(pane);
    if (!state) {
      state = { cpu: new Map(), initialized: false, active: false, activeSince: 0, lastRawAt: 0, doneUntil: 0 };
      this.#panes.set(pane, state);
    }
    const children = input.procs.filter((proc) => proc.depth > 0);
    let raw: boolean;
    if (input.agent) {
      let delta = 0;
      if (state.initialized) {
        for (const proc of children) delta += Math.max(0, proc.cpuNs - (state.cpu.get(proc.pid) ?? 0));
      }
      raw = delta >= CPU_ACTIVE_NS;
    } else {
      raw = !input.atPrompt && children.some((proc) => proc.foreground);
    }
    state.cpu = new Map(children.map((proc) => [proc.pid, proc.cpuNs]));
    state.initialized = true;

    if (raw) {
      state.lastRawAt = now;
      if (!state.active) {
        state.active = true;
        state.activeSince = now;
      }
      return;
    }
    if (!state.active) return;
    if (input.agent && now - state.lastRawAt < QUIET_MS) return;
    // 结束：脚本按看到它结束的时刻算时长，AI CLI 按最后一次有动静的时刻算（不含停涨等待）。
    const end = input.agent ? state.lastRawAt : now;
    state.active = false;
    if (end - state.activeSince >= DONE_MIN_MS) state.doneUntil = now + DONE_TTL_MS;
  }

  status(pane: number, now: number): Tty7AgentStatus | null {
    const state = this.#panes.get(pane);
    if (!state) return null;
    if (state.active && now - state.activeSince >= WORKING_MIN_MS) return "working";
    if (now < state.doneUntil) return "done";
    return null;
  }

  /** 只保留还活着的会话。 */
  retain(panes: ReadonlySet<number>): void {
    for (const pane of [...this.#panes.keys()]) if (!panes.has(pane)) this.#panes.delete(pane);
  }
}

export interface Tty7ProcsView {
  atPrompt: boolean;
  procs: ActivityProc[];
}

export interface ActivityMonitorOptions {
  /** 不带活动状态的会话列表（hooks 上报的状态才算数）。 */
  sessions(): Promise<Tty7SessionsView>;
  procs(pane: number): Promise<Tty7ProcsView>;
  /** 某个会话的派生状态变了。 */
  onChange(): void;
  now?(): number;
  intervalMs?: number;
}

/** 定时给没有 hooks 状态的会话采样，维护 ActivityTracker。 */
export class ActivityMonitor {
  readonly #options: ActivityMonitorOptions;
  readonly #tracker = new ActivityTracker();
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #last = new Map<number, Tty7AgentStatus | null>();

  constructor(options: ActivityMonitorOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** 供 Tty7.sessions() 合并：这个会话当前的派生状态。 */
  status(pane: number): Tty7AgentStatus | null {
    return this.#tracker.status(pane, this.#now());
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.tick(), this.#options.intervalMs ?? ACTIVITY_INTERVAL_MS);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      let view: Tty7SessionsView;
      try {
        view = await this.#options.sessions();
      } catch {
        return;
      }
      if (!view.available) return;
      const live = new Set(view.sessions.map((session) => session.pane));
      this.#tracker.retain(live);
      // hooks 上报了状态的会话以 hooks 为准；休眠的会话没有进程可采。
      const targets = view.sessions.filter((session) => session.status === null && !session.hibernated);
      await Promise.all(
        targets.map(async (session) => {
          try {
            const sample = await this.#options.procs(session.pane);
            this.#tracker.observe(
              session.pane,
              { agent: session.agent !== null, atPrompt: sample.atPrompt, procs: sample.procs },
              this.#now(),
            );
          } catch {
            // 这一轮采不到就跳过，保留上一次判断。
          }
        }),
      );
      const next = new Map<number, Tty7AgentStatus | null>();
      for (const session of view.sessions) next.set(session.pane, this.#tracker.status(session.pane, this.#now()));
      let changed = false;
      for (const [pane, status] of next) if ((this.#last.get(pane) ?? null) !== status) changed = true;
      this.#last = next;
      if (changed) {
        try {
          this.#options.onChange();
        } catch {
          // 通知失败不影响采样。
        }
      }
    } finally {
      this.#running = false;
    }
  }
}
