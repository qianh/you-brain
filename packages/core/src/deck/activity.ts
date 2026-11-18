import type { Tty7AgentStatus, Tty7SessionsView } from "./tty7.js";

/**
 * 终端「是否在执行 / 是否在等输入」的通用判断：不依赖 agent hooks，所有 AI CLI 和普通脚本都适用。
 * 数据来自 `tty7 procs`（进程树、前台进程、是否停在 shell 提示符、每个进程的累计 CPU 时间），
 * 以及进程静默时按需读取一次屏幕末尾几行（`tty7 capture --tail`）识别交互提示。
 *
 * - 普通脚本（会话里没有识别出 agent）：前台有非 shell 进程且没回到提示符 = 执行中，回到提示符 = 结束；
 *   若前台进程 CPU 连续静默且屏幕末尾出现确认/密码/输入提示（如 `[y/N]`、`Password:`、`继续吗？`），判为 `waiting`。
 * - AI CLI（识别出 agent）：它停在输入框时也一直在前台，所以改看进程树的 CPU 时间有没有在涨；
 *   停涨超过 QUIET_MS 才算停下（模型思考、等网络时 CPU 会短暂不涨），此时若屏幕末尾是交互提问则给 `waiting`，否则给 `done`。
 * - 有 hooks 状态的会话不在这里判断（hooks 更准，自带状态说明）。
 *
 * 产出的状态有 working、waiting 和 done：
 * - 连续执行 WORKING_MIN_MS 以上才显示 working（`ls` 这种瞬间命令不闪，也为后续 waiting 建立基线）。
 * - 执行 DONE_MIN_MS 以上才在结束时给 done（短命令不提醒），done 保留 DONE_TTL_MS。
 */
export const ACTIVITY_INTERVAL_MS = 3_000;
const WORKING_MIN_MS = 3_000;
const DONE_MIN_MS = 10_000;
const DONE_TTL_MS = 120_000;
/** AI CLI：CPU 停涨多久才算结束。 */
const QUIET_MS = 8_000;
/** 普通脚本：前台进程 CPU 连续静默多久后，去读一次屏幕末尾看是不是在等用户输入。 */
const SCRIPT_QUIET_MS = 6_000;
/** 静默持续期间隔多久复查一次屏幕末尾（避免每 3 秒都跑 capture，又能跟上多步交互提示）。 */
const PROMPT_RECHECK_MS = 9_000;
/** 一次采样间隔内进程树 CPU 增加超过这个值才算「有 CPU 动静」（空闲实测约 6ms / 2s）。 */
const CPU_ACTIVE_NS = 40_000_000;
const PROMPT_TEXT_MAX = 120;

const ANSI_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/gu;
const YES_NO_PROMPT = /(\[[yY]\/[nN]\]|\([yY]\/[nN]\)|\[yes\/no\]|\(yes\/no\))/u;
const CREDENTIAL_PROMPT =
  /(?:\b(?:password|passphrase|passcode|verification code|auth code|otp)\b[^/\n]{0,40}[:：?？]?|(?:密码|口令|验证码)\s*[:：?？])\s*$/iu;
const KEY_OR_INPUT_PROMPT =
  /(?:\b(?:press enter|hit enter|press return|press any key|enter your choice|enter selection|type ['"]?yes['"]?)\b|(?:按回车|按任意键|请输入|请选择|是否继续|确认继续))/iu;
const MENU_OPTION_LINE = /^(?:[❯›>●○◉◯]|\[[ xX]\])\s+\S/u;
const MENU_QUESTION_LINE = /^(?:[?◆◇•]\s+.+|.+[?？:：])$/u;

function clipPrompt(line: string): string {
  const compact = line.replace(/\s+/gu, " ").trim();
  return compact.length > PROMPT_TEXT_MAX ? `${compact.slice(0, PROMPT_TEXT_MAX - 1)}…` : compact;
}

/**
 * 从终端屏幕末尾文本里提取「正在等用户输入」的提示行；普通输出（构建日志、进度条、sleep）返回 null。
 */
export function extractWaitingPrompt(screenText: string): string | null {
  const cleaned = screenText.replace(ANSI_ESCAPE, "");
  const lines = cleaned
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return null;

  const last = lines[lines.length - 1]!;
  // 末尾是省略号通常是「正在加载... / Building...」，不是提问。
  if (/(?:\.{3}|…)\s*$/u.test(last)) return null;

  for (const line of lines.slice(-2).reverse()) {
    if (YES_NO_PROMPT.test(line)) return clipPrompt(line);
  }
  if (CREDENTIAL_PROMPT.test(last)) return clipPrompt(last);
  if (KEY_OR_INPUT_PROMPT.test(last)) return clipPrompt(last);

  const tail = lines.slice(-5);
  if (tail.some((line) => MENU_OPTION_LINE.test(line))) {
    const question = [...tail].reverse().find((line) => !MENU_OPTION_LINE.test(line) && MENU_QUESTION_LINE.test(line));
    if (question) return clipPrompt(question.replace(/^[?◆◇•]\s+/u, ""));
  }

  if (
    last.length <= 140 &&
    !/^https?:\/\/\S+$/iu.test(last) &&
    !/^\s*at\s+\S+/u.test(last) &&
    /[?？]\s*$/u.test(last)
  ) {
    return clipPrompt(last);
  }
  return null;
}

export interface ActivityDetail {
  status: Tty7AgentStatus;
  message: string | null;
}

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
  agent: boolean;
  cpu: Map<number, number>;
  initialized: boolean;
  active: boolean;
  activeSince: number;
  lastRawAt: number;
  quietSince: number | null;
  agentJustStopped: boolean;
  waitingPrompt: string | null;
  promptCheckedAt: number;
  doneUntil: number;
}

export class ActivityTracker {
  readonly #panes = new Map<number, PaneState>();

  observe(pane: number, input: ActivityInput, now: number): void {
    let state = this.#panes.get(pane);
    if (!state) {
      state = {
        agent: input.agent,
        cpu: new Map(),
        initialized: false,
        active: false,
        activeSince: 0,
        lastRawAt: 0,
        quietSince: null,
        agentJustStopped: false,
        waitingPrompt: null,
        promptCheckedAt: -1,
        doneUntil: 0,
      };
      this.#panes.set(pane, state);
    }
    state.agent = input.agent;
    const children = input.procs.filter((proc) => proc.depth > 0);
    let delta = 0;
    if (state.initialized) {
      for (const proc of children) delta += Math.max(0, proc.cpuNs - (state.cpu.get(proc.pid) ?? 0));
    }
    const cpuActive = delta >= CPU_ACTIVE_NS;
    const raw = input.agent ? cpuActive : !input.atPrompt && children.some((proc) => proc.foreground);
    state.cpu = new Map(children.map((proc) => [proc.pid, proc.cpuNs]));
    state.initialized = true;

    if (raw) {
      state.lastRawAt = now;
      state.agentJustStopped = false;
      if (!state.active) {
        state.active = true;
        state.activeSince = now;
        state.quietSince = input.agent ? null : now;
        state.waitingPrompt = null;
        state.promptCheckedAt = -1;
      } else if (cpuActive) {
        state.quietSince = null;
        state.waitingPrompt = null;
      } else if (state.quietSince === null) {
        state.quietSince = now;
      }
      return;
    }

    if (input.atPrompt || children.length === 0) {
      state.quietSince = null;
      state.agentJustStopped = false;
      state.waitingPrompt = null;
    }
    if (!state.active) return;
    if (input.agent && now - state.lastRawAt < QUIET_MS) return;
    // 结束：脚本按看到它结束的时刻算时长，AI CLI 按最后一次有动静的时刻算（不含停涨等待）。
    const end = input.agent ? state.lastRawAt : now;
    const ranWorking = end - state.activeSince >= WORKING_MIN_MS;
    state.active = false;
    state.quietSince = null;
    state.waitingPrompt = null;
    if (input.agent && !input.atPrompt && children.length > 0 && ranWorking) {
      state.agentJustStopped = true;
    }
    if (end - state.activeSince >= DONE_MIN_MS) state.doneUntil = now + DONE_TTL_MS;
  }

  /** 是否需要读一次屏幕末尾，判断当前静默是正常耗时还是在等用户输入。 */
  needsPromptCheck(pane: number, now: number): boolean {
    const state = this.#panes.get(pane);
    if (!state) return false;
    if (state.agent) {
      if (state.agentJustStopped) return true;
      return state.waitingPrompt !== null && now - state.promptCheckedAt >= PROMPT_RECHECK_MS;
    }
    if (!state.active || now - state.activeSince < WORKING_MIN_MS || state.quietSince === null) return false;
    if (now - state.quietSince < SCRIPT_QUIET_MS) return false;
    return state.promptCheckedAt < state.quietSince || now - state.promptCheckedAt >= PROMPT_RECHECK_MS;
  }

  /** 写入屏幕末尾提示检测结果。 */
  setPrompt(pane: number, prompt: string | null, now: number): void {
    const state = this.#panes.get(pane);
    if (!state) return;
    state.agentJustStopped = false;
    state.promptCheckedAt = now;
    state.waitingPrompt = prompt;
    if (prompt !== null && state.agent) {
      // AI CLI 停下来是在等用户确认，不是已完成。
      state.doneUntil = 0;
    }
  }

  detail(pane: number, now: number): ActivityDetail | null {
    const state = this.#panes.get(pane);
    if (!state) return null;
    if (state.waitingPrompt !== null) return { status: "waiting", message: state.waitingPrompt };
    if (state.active && now - state.activeSince >= WORKING_MIN_MS) return { status: "working", message: null };
    if (now < state.doneUntil) return { status: "done", message: null };
    return null;
  }

  status(pane: number, now: number): Tty7AgentStatus | null {
    return this.detail(pane, now)?.status ?? null;
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
  /** 读取会话屏幕末尾几行纯文本，仅在进程静默疑似等待输入时按需调用。 */
  screen?(pane: number): Promise<string>;
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
  #last = new Map<number, string>();

  constructor(options: ActivityMonitorOptions) {
    this.#options = options;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  /** 供 Tty7.sessions() 合并：这个会话当前的派生状态与提示语。 */
  detail(pane: number): ActivityDetail | null {
    return this.#tracker.detail(pane, this.#now());
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
            const at = this.#now();
            this.#tracker.observe(
              session.pane,
              { agent: session.agent !== null, atPrompt: sample.atPrompt, procs: sample.procs },
              at,
            );
            if (this.#options.screen && this.#tracker.needsPromptCheck(session.pane, at)) {
              const text = await this.#options.screen(session.pane);
              this.#tracker.setPrompt(session.pane, extractWaitingPrompt(text), this.#now());
            }
          } catch {
            // 这一轮采不到就跳过，保留上一次判断。
          }
        }),
      );
      const next = new Map<number, string>();
      for (const session of view.sessions) {
        const current = this.#tracker.detail(session.pane, this.#now());
        next.set(session.pane, current ? `${current.status}:${current.message ?? ""}` : "");
      }
      let changed = false;
      for (const [pane, key] of next) if ((this.#last.get(pane) ?? "") !== key) changed = true;
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
