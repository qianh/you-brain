import type { ReorganizePlan } from "./reorganize.js";

export type ReorganizeJobStatus =
  | { state: "idle" }
  /** Waiting for its turn behind other model calls. */
  | { state: "queued"; startedAt: string }
  | { state: "running"; startedAt: string }
  | { state: "ready"; plan: ReorganizePlan }
  | { state: "failed"; message: string };

export interface ReorganizeJobOptions {
  now: () => string;
  /** Includes the time spent queued. */
  deadlineMs?: number;
}

/** Two attempts of twenty minutes each, plus room to wait for a turn. */
export const REORGANIZE_DEADLINE_MS = 45 * 60_000;
const MESSAGE_CHARS = 500;

/**
 * The daemon's own record of a plan in progress. A plan takes minutes, so the page must
 * not depend on one HTTP request staying open: a lost request used to leave the dialog
 * spinning with nothing running behind it. The page asks for this status instead.
 */
export class ReorganizeJob {
  readonly #now: () => string;
  readonly #deadlineMs: number;
  #status: ReorganizeJobStatus = { state: "idle" };
  #run = 0;

  constructor(options: ReorganizeJobOptions) {
    this.#now = options.now;
    this.#deadlineMs = options.deadlineMs ?? REORGANIZE_DEADLINE_MS;
  }

  status(): ReorganizeJobStatus {
    return this.#status;
  }

  /** Starts a run if none is going. A refresh never queues a second call behind the first. */
  start(
    work: (onRunning: () => void) => Promise<ReorganizePlan>,
    options: { refresh?: boolean } = {},
  ): ReorganizeJobStatus {
    const { state } = this.#status;
    if (state === "queued" || state === "running") return this.#status;
    if (state === "ready" && options.refresh !== true) return this.#status;

    this.#run += 1;
    const run = this.#run;
    const startedAt = this.#now();
    this.#status = { state: "queued", startedAt };

    const deadline = setTimeout(() => {
      if (run !== this.#run || this.#status.state === "ready") return;
      const minutes = Math.round(this.#deadlineMs / 60_000);
      this.#status = {
        state: "failed",
        message: `等了 ${minutes} 分钟还没有结果，这次整理已放弃。可以再试一次。`,
      };
    }, this.#deadlineMs);
    deadline.unref?.();

    const settle = (status: ReorganizeJobStatus): void => {
      clearTimeout(deadline);
      if (run === this.#run) this.#status = status;
    };
    const fail = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      settle({ state: "failed", message: message.slice(0, MESSAGE_CHARS) });
    };

    try {
      work(() => {
        if (run === this.#run && this.#status.state === "queued") {
          this.#status = { state: "running", startedAt };
        }
      }).then((plan) => settle({ state: "ready", plan }), fail);
    } catch (error) {
      fail(error);
    }
    return this.#status;
  }

  clear(): void {
    this.#run += 1;
    this.#status = { state: "idle" };
  }
}
