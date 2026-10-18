import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_UPLOAD_ACTIVE_INTERVAL_MINUTES,
} from "@you-brain/protocol";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface ScheduleState {
  lastActivityAt: number | null;
  lastUploadAt: number | null;
  /** Start of the current dirty period. Null when nothing new needs upload. */
  dirtySince: number | null;
}

export interface ScheduleOptions {
  idleMs?: number;
  activeIntervalMs?: number;
}

export interface UploadDecision {
  due: boolean;
  reason: "idle" | "active" | "waiting";
  waitMs: number;
}

export function emptySchedule(): ScheduleState {
  return { lastActivityAt: null, lastUploadAt: null, dirtySince: null };
}

function resolved(options?: ScheduleOptions): {
  idleMs: number;
  activeIntervalMs: number;
} {
  return {
    idleMs: options?.idleMs ?? DEFAULT_IDLE_MINUTES * 60_000,
    activeIntervalMs:
      options?.activeIntervalMs ??
      DEFAULT_UPLOAD_ACTIVE_INTERVAL_MINUTES * 60_000,
  };
}

export function noteActivity(state: ScheduleState, at: number): ScheduleState {
  return {
    lastActivityAt: at,
    lastUploadAt: state.lastUploadAt,
    dirtySince: state.dirtySince ?? at,
  };
}

export function noteUpload(state: ScheduleState, at: number): ScheduleState {
  return {
    lastActivityAt: state.lastActivityAt,
    lastUploadAt: at,
    dirtySince: null,
  };
}

/**
 * Upload after the session goes idle. While it stays active, upload at most
 * once per active interval, measured from the previous upload (or from the
 * start of the dirty period when nothing has been uploaded yet).
 */
export function decideUpload(
  state: ScheduleState,
  now: number,
  options?: ScheduleOptions,
): UploadDecision {
  if (state.lastActivityAt === null || state.dirtySince === null) {
    return { due: false, reason: "waiting", waitMs: Number.POSITIVE_INFINITY };
  }
  const { idleMs, activeIntervalMs } = resolved(options);
  const idleFor = now - state.lastActivityAt;
  if (idleFor >= idleMs) {
    return { due: true, reason: "idle", waitMs: 0 };
  }
  const anchor = state.lastUploadAt ?? state.dirtySince;
  const activeFor = now - anchor;
  if (activeFor >= activeIntervalMs) {
    return { due: true, reason: "active", waitMs: 0 };
  }
  const untilIdle = idleMs - idleFor;
  const untilActive = activeIntervalMs - activeFor;
  return {
    due: false,
    reason: "waiting",
    waitMs: Math.max(0, Math.min(untilIdle, untilActive)),
  };
}

export class UploadScheduler {
  readonly #states = new Map<string, ScheduleState>();
  readonly #clock: Clock;
  readonly #options: ScheduleOptions;

  constructor(clock: Clock = systemClock, options: ScheduleOptions = {}) {
    this.#clock = clock;
    this.#options = options;
  }

  noteActivity(key: string, at = this.#clock.now()): void {
    const current = this.#states.get(key) ?? emptySchedule();
    this.#states.set(key, noteActivity(current, at));
  }

  noteUpload(key: string, at = this.#clock.now()): void {
    const current = this.#states.get(key) ?? emptySchedule();
    this.#states.set(key, noteUpload(current, at));
  }

  decide(key: string, now = this.#clock.now()): UploadDecision {
    return decideUpload(this.#states.get(key) ?? emptySchedule(), now, this.#options);
  }
}
