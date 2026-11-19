import type { T3ThreadBrief } from "./automation.js";

/**
 * T3 会话监视：定时列出全部项目的顶层会话，发现「执行中 → 做完一轮 / 等你处理 / 失败」时产生一条提醒。
 * 只在 enabled() 为真时（Telegram 已绑定）轮询，T3 没开或未授权时逐步拉长间隔，不反复打扰 t3 CLI。
 */

export type T3NoticeKind = "done" | "waiting" | "failed";

export interface T3Notice {
  threadId: string;
  title: string;
  kind: T3NoticeKind;
  link: string | null;
}

export interface T3ThreadWatcherOptions {
  list(): Promise<T3ThreadBrief[]>;
  enabled(): boolean;
  onNotice(notice: T3Notice): void;
  pollMs?: number;
  /** 出错后的间隔，逐次加长，用完停在最后一档。 */
  retryMs?: readonly number[];
}

const ACTIVE = new Set(["preparing", "queued", "starting", "running"]);
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_RETRY_MS = [60_000, 120_000, 300_000] as const;

interface Seen {
  status: string;
  latestRunId: string | null;
}

/**
 * 比较前后两次列表，返回这一轮的提醒。`previous` 为 null 是第一次，只建立基线。
 * 两次之间整轮跑完（上次 completed、这次 completed 但 latestRunId 变了）也算做完一轮。
 */
export function diffT3Threads(previous: ReadonlyMap<string, Seen> | null, threads: readonly T3ThreadBrief[]): T3Notice[] {
  if (previous === null) return [];
  const result: T3Notice[] = [];
  for (const thread of threads) {
    const before = previous.get(thread.threadId);
    if (before === undefined || thread.snoozed) continue;
    const newRun = before.latestRunId !== thread.latestRunId;
    const wasBusy = ACTIVE.has(before.status) || newRun;
    let kind: T3NoticeKind | null = null;
    if (thread.status === "waiting" && (before.status !== "waiting" || newRun)) kind = "waiting";
    else if (thread.status === "completed" && (wasBusy || before.status === "waiting")) kind = "done";
    else if (thread.status === "failed" && wasBusy) kind = "failed";
    if (kind !== null) result.push({ threadId: thread.threadId, title: thread.title, kind, link: thread.link });
  }
  return result;
}

export class T3ThreadWatcher {
  readonly #options: T3ThreadWatcherOptions;
  #seen: Map<string, Seen> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  #failures = 0;
  /** 最近一次看到的状态，回复时用来判断会话是不是卡在 T3 里的授权/提问。 */
  readonly #status = new Map<string, string>();

  constructor(options: T3ThreadWatcherOptions) {
    this.#options = options;
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

  statusOf(threadId: string): string | null {
    return this.#status.get(threadId) ?? null;
  }

  #schedule(ms: number): void {
    if (!this.#started) return;
    this.#timer = setTimeout(() => void this.tick(), ms);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  /** 读一次并比较；测试可直接调用。 */
  async tick(): Promise<void> {
    this.#timer = null;
    let next = this.#options.pollMs ?? DEFAULT_POLL_MS;
    try {
      if (!this.#options.enabled()) {
        // 关着期间的变化不补发：重新打开后从新基线算起。
        this.#seen = null;
        return;
      }
      const threads = await this.#options.list();
      this.#failures = 0;
      const found = diffT3Threads(this.#seen, threads);
      this.#seen = new Map(threads.map((thread) => [thread.threadId, { status: thread.status, latestRunId: thread.latestRunId }]));
      this.#status.clear();
      for (const thread of threads) this.#status.set(thread.threadId, thread.status);
      for (const notice of found) {
        try {
          this.#options.onNotice(notice);
        } catch {
          // 推送失败不影响监视。
        }
      }
    } catch {
      const retry = this.#options.retryMs ?? DEFAULT_RETRY_MS;
      next = retry[Math.min(this.#failures, retry.length - 1)]!;
      this.#failures += 1;
    } finally {
      this.#schedule(next);
    }
  }
}
