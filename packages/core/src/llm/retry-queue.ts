import { isLlmRequestError, type LlmErrorKind } from "./errors.js";

export interface RetryClock {
  now(): number;
}

export interface RetryQueueOptions {
  clock?: RetryClock;
  baseDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  /** After this many failures the job stays visible but is no longer due. */
  maxAttempts?: number;
}

export type RetryFailureKind = LlmErrorKind | "unknown";

export interface RetryJob<T> {
  id: string;
  payload: T;
  attempts: number;
  reason: string;
  kind: RetryFailureKind;
  retryable: boolean;
  failedAt: number;
  nextAttemptAt: number;
  exhausted: boolean;
}

export interface LlmRetryStatus {
  id: string;
  reason: string;
  kind: RetryFailureKind;
  retryable: boolean;
  attempts: number;
  failedAt: number;
  nextAttemptAt: number;
  exhausted: boolean;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;

export function retryDelayMs(
  attempt: number,
  options?: { baseDelayMs?: number; factor?: number; maxDelayMs?: number },
): number {
  const base = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const factor = options?.factor ?? DEFAULT_FACTOR;
  const max = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const n = Math.max(1, Math.floor(attempt));
  const raw = base * factor ** (n - 1);
  if (!Number.isFinite(raw)) return max;
  return Math.min(max, raw);
}

export function describeFailure(error: unknown): {
  kind: RetryFailureKind;
  reason: string;
  retryable: boolean;
} {
  if (isLlmRequestError(error)) {
    return { kind: error.kind, reason: error.message, retryable: error.retryable };
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return { kind: "unknown", reason: error.message, retryable: true };
  }
  return { kind: "unknown", reason: "未知错误", retryable: true };
}

export class LlmRetryQueue<T> {
  private readonly jobs = new Map<string, RetryJob<T>>();
  private readonly clock: RetryClock;
  private readonly baseDelayMs: number;
  private readonly factor: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number | null;

  constructor(options: RetryQueueOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.factor = options.factor ?? DEFAULT_FACTOR;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? null;
  }

  fail(id: string, payload: T, error: unknown): RetryJob<T> {
    const previous = this.jobs.get(id);
    const attempts = (previous?.attempts ?? 0) + 1;
    const described = describeFailure(error);
    const now = this.clock.now();
    const exhausted =
      !described.retryable ||
      (this.maxAttempts !== null && attempts >= this.maxAttempts);
    const job: RetryJob<T> = {
      id,
      payload,
      attempts,
      reason: described.reason,
      kind: described.kind,
      retryable: described.retryable && !exhausted,
      failedAt: now,
      nextAttemptAt:
        now +
        retryDelayMs(attempts, {
          baseDelayMs: this.baseDelayMs,
          factor: this.factor,
          maxDelayMs: this.maxDelayMs,
        }),
      exhausted,
    };
    this.jobs.set(id, job);
    return { ...job };
  }

  succeed(id: string): void {
    this.jobs.delete(id);
  }

  get(id: string): RetryJob<T> | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  due(now = this.clock.now()): RetryJob<T>[] {
    return [...this.jobs.values()]
      .filter((job) => !job.exhausted && job.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id.localeCompare(b.id))
      .map((job) => ({ ...job }));
  }

  /** Failures for the status page, latest failure first. */
  pending(): LlmRetryStatus[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.failedAt - a.failedAt || a.id.localeCompare(b.id))
      .map((job) => ({
        id: job.id,
        reason: job.reason,
        kind: job.kind,
        retryable: job.retryable,
        attempts: job.attempts,
        failedAt: job.failedAt,
        nextAttemptAt: job.nextAttemptAt,
        exhausted: job.exhausted,
      }));
  }

  size(): number {
    return this.jobs.size;
  }
}
