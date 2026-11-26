import type { LlmBackend } from "../llm/types.js";
import type { ConsolidateLease } from "./lease.js";
import { runConsolidation, type ConsolidationRunResult } from "./run.js";
import {
  consolidationBlock,
  consolidationTimeDue,
  localDayKey,
  nextBackoffMs,
  planConsolidationDays,
  type ConsolidationBlock,
} from "./schedule.js";
import {
  consolidationSteps,
  type ConsolidationContext,
  type ConsolidationPortrait,
  type ConsolidationStep,
} from "./steps.js";

export interface ConsolidationLastRun {
  day: string;
  ok: boolean;
  error?: string;
  /** The step that failed the run (failures only). */
  step?: string;
  /** Advisory steps that failed without failing the run, as `步骤：原因`. */
  warnings?: string[];
  finishedAt: string;
}

export interface ConsolidationState {
  backoffMs: number;
  retryAtMs: number | null;
  lastRun: ConsolidationLastRun | null;
}

export function emptyConsolidationState(): ConsolidationState {
  return { backoffMs: 0, retryAtMs: null, lastRun: null };
}

export interface ConsolidationRuntime {
  deviceId: string;
  mainDevice: string | null;
  enabled: boolean;
  time: string;
  timeZone: string;
  hasLlm: boolean;
  hasDrive: boolean;
  llm: LlmBackend | null;
  activeLimit: number;
  historyDays: number;
  clock: { now(): Date; nowMs(): number };
  load: ConsolidationContext["load"];
  ready?: () => Promise<boolean>;
  emit: ConsolidationContext["emit"];
  cursors: ConsolidationContext["cursors"];
  portrait?: ConsolidationPortrait;
  topicFiles?: ConsolidationContext["topicFiles"];
  topicTranscripts?: ConsolidationContext["topicTranscripts"];
  readLease: () => Promise<ConsolidateLease | null>;
  writeLease: (lease: ConsolidateLease) => Promise<void>;
  steps?: readonly ConsolidationStep[];
  signal?: AbortSignal;
  stepBudgetMs?: number;
}

export type ConsolidationExecution =
  | { status: "skipped"; reason: "gates" | "not_due" | "backoff" | "timezone"; day: string }
  | { status: "rejected"; code: ConsolidationBlock }
  | { status: "done"; attempted: boolean; result: ConsolidationRunResult };

export class ConsolidationRejected extends Error {
  readonly code: ConsolidationBlock;

  constructor(code: ConsolidationBlock) {
    super(code);
    this.name = "ConsolidationRejected";
    this.code = code;
  }
}

export function consolidationRejectMessage(code: ConsolidationBlock): string {
  switch (code) {
    case "NOT_MAIN_DEVICE":
      return "只有主设备可以执行沉淀";
    case "DISABLED":
      return "全局沉淀未启用";
    case "NO_LLM":
      return "模型不可用";
    case "NO_DRIVE":
      return "Drive 未打开";
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

export async function executeConsolidation(
  runtime: ConsolidationRuntime,
  state: ConsolidationState,
  options: { manual: boolean; force: boolean },
): Promise<ConsolidationExecution> {
  const block = consolidationBlock({
    deviceId: runtime.deviceId,
    mainDevice: runtime.mainDevice,
    enabled: runtime.enabled,
    hasLlm: runtime.hasLlm,
    hasDrive: runtime.hasDrive,
  });
  if (block) {
    if (options.manual) return { status: "rejected", code: block };
    return { status: "skipped", reason: "gates", day: "" };
  }
  let today: string;
  try {
    today = localDayKey(runtime.clock.now(), runtime.timeZone);
  } catch {
    if (options.manual) throw new Error("时区无效");
    return { status: "skipped", reason: "timezone", day: "" };
  }
  if (!options.manual) {
    if (state.retryAtMs !== null && runtime.clock.nowMs() < state.retryAtMs) {
      return { status: "skipped", reason: "backoff", day: today };
    }
    if (!consolidationTimeDue(runtime.clock.now(), runtime.timeZone, runtime.time)) {
      return { status: "skipped", reason: "not_due", day: today };
    }
  }
  const llm = runtime.llm;
  if (!llm) {
    if (options.manual) return { status: "rejected", code: "NO_LLM" };
    return { status: "skipped", reason: "gates", day: today };
  }
  let lease: ConsolidateLease | null = null;
  try {
    lease = await runtime.readLease();
  } catch {
    lease = null;
  }
  const days = planConsolidationDays({
    leaseDate: lease?.date ?? null,
    today,
    force: options.force,
  });
  if (days.length === 0) {
    return {
      status: "done",
      attempted: false,
      result: { day: today, ok: true, steps: [], warnings: [] },
    };
  }
  if (runtime.ready && !(await runtime.ready())) {
    return { status: "skipped", reason: "gates", day: today };
  }
  const steps = runtime.steps ?? consolidationSteps();
  let last: ConsolidationRunResult = { day: today, ok: true, steps: [], warnings: [] };
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index]!;
    if (runtime.signal?.aborted) {
      return {
        status: "done",
        attempted: index > 0,
        result: { day, ok: false, aborted: true, steps: [], warnings: [] },
      };
    }
    const result = await runConsolidation({
      day,
      timeZone: runtime.timeZone,
      now: () => runtime.clock.now(),
      load: runtime.load,
      zone: { activeLimit: runtime.activeLimit, historyDays: runtime.historyDays },
      llm,
      emit: runtime.emit,
      cursors: runtime.cursors,
      steps,
      isFinalDay: index === days.length - 1,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
      ...(runtime.stepBudgetMs === undefined ? {} : { stepBudgetMs: runtime.stepBudgetMs }),
      ...(runtime.portrait ? { portrait: runtime.portrait } : {}),
      ...(runtime.topicFiles ? { topicFiles: runtime.topicFiles } : {}),
      ...(runtime.topicTranscripts ? { topicTranscripts: runtime.topicTranscripts } : {}),
    });
    last = result;
    if (result.aborted || runtime.signal?.aborted) {
      return { status: "done", attempted: true, result: { ...result, ok: false, aborted: true } };
    }
    const finishedAt = runtime.clock.now().toISOString();
    if (!result.ok) {
      const failed = failedStep(result, steps);
      rememberFailure(state, runtime.clock.nowMs(), {
        day,
        ok: false,
        error: failed?.error ?? "每日沉淀没有完成",
        ...(failed ? { step: failed.id } : {}),
        finishedAt,
      });
      return { status: "done", attempted: true, result };
    }
    try {
      if (runtime.signal?.aborted) {
        return { status: "done", attempted: true, result: { ...result, ok: false, aborted: true } };
      }
      await runtime.writeLease({ date: day, deviceId: runtime.deviceId, finishedAt });
    } catch {
      if (runtime.signal?.aborted) {
        return { status: "done", attempted: true, result: { ...result, ok: false, aborted: true } };
      }
      const failed: ConsolidationRunResult = {
        ...result,
        ok: false,
        warnings: [...result.warnings, "沉淀记录没有写上"],
      };
      rememberFailure(state, runtime.clock.nowMs(), {
        day,
        ok: false,
        error: "沉淀记录没有写上",
        finishedAt,
      });
      return { status: "done", attempted: true, result: failed };
    }
  }
  state.backoffMs = 0;
  state.retryAtMs = null;
  const skipped = advisoryFailures(last, steps);
  state.lastRun = {
    day: last.day,
    ok: true,
    ...(skipped.length > 0 ? { warnings: skipped } : {}),
    finishedAt: runtime.clock.now().toISOString(),
  };
  return { status: "done", attempted: true, result: last };
}

function rememberFailure(
  state: ConsolidationState,
  nowMs: number,
  lastRun: ConsolidationLastRun,
): void {
  state.backoffMs = nextBackoffMs(state.backoffMs);
  state.retryAtMs = nowMs + state.backoffMs;
  state.lastRun = lastRun;
}

/** The step that failed the run: the first failed one that is not advisory. */
function failedStep(
  result: ConsolidationRunResult,
  steps: readonly ConsolidationStep[],
): ConsolidationRunResult["steps"][number] | undefined {
  const advisory = new Set(steps.filter((step) => step.advisory).map((step) => step.id));
  return result.steps.find((step) => !step.ok && !advisory.has(step.id));
}

function advisoryFailures(result: ConsolidationRunResult, steps: readonly ConsolidationStep[]): string[] {
  const advisory = new Set(steps.filter((step) => step.advisory).map((step) => step.id));
  return result.steps
    .filter((step) => !step.ok && advisory.has(step.id))
    .map((step) => `${step.id}：${step.error ?? "失败"}`);
}
