export interface LatencySummary {
  n: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

/** Nearest-rank percentile. `p` is 0–1. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile requires samples");
  if (p < 0 || p > 1) throw new Error("percentile p must be between 0 and 1");
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  const value = sorted[index];
  if (value === undefined) throw new Error("percentile index missing");
  return value;
}

export function summarizeLatencies(samplesMs: readonly number[]): LatencySummary {
  if (samplesMs.length === 0) throw new Error("latency summary requires samples");
  for (const sample of samplesMs) {
    if (!Number.isFinite(sample) || sample < 0) {
      throw new Error("latency samples must be finite and non-negative");
    }
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  if (minMs === undefined || maxMs === undefined) throw new Error("latency summary empty");
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    n: sorted.length,
    minMs,
    maxMs,
    meanMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

/**
 * Official Drive API quota as of 2026-09-11.
 * https://developers.google.com/workspace/drive/api/guides/limits
 *
 * `changes.list` is not named. `listUnits` defaults to the files.list bucket (100).
 * The "other actions" bucket is 5. Callers should report both.
 */
export const DRIVE_QUOTA = {
  source: "https://developers.google.com/workspace/drive/api/guides/limits",
  retrieved: "2026-09-11",
  perMinutePerProject: 1_000_000,
  perMinutePerUserPerProject: 325_000,
  perDayBillingUnits: 400_000_000,
  perDayEgressBytes: 1_099_511_627_776,
  units: { read: 5, list: 100, download: 200, edit: 50, other: 5 },
} as const;

export interface PollQuota {
  intervalSeconds: number;
  devices: number;
  unitsPerCall: number;
  callsPerMinutePerDevice: number;
  callsPerDayPerDevice: number;
  unitsPerMinutePerDevice: number;
  unitsPerMinuteSameUser: number;
  unitsPerMinuteProject: number;
  unitsPerDaySameUser: number;
  userMinuteFraction: number;
  projectMinuteFraction: number;
  dayBillingFraction: number;
}

/** 60-second `changes.list` projection. `changes.list` is not a named bucket. */
export function sixtySecondChangeQuota(devices = 1): { asList: PollQuota; asOther: PollQuota } {
  const shared = { intervalSeconds: 60, devices };
  return {
    asList: pollQuota({ ...shared, unitsPerCall: DRIVE_QUOTA.units.list }),
    asOther: pollQuota({ ...shared, unitsPerCall: DRIVE_QUOTA.units.other }),
  };
}

export function pollQuota(input: {
  intervalSeconds: number;
  devices: number;
  unitsPerCall: number;
  perMinutePerProject?: number;
  perMinutePerUser?: number;
  perDayBillingUnits?: number;
}): PollQuota {
  if (input.intervalSeconds <= 0 || input.devices <= 0 || input.unitsPerCall < 0) {
    throw new Error("poll quota inputs must be positive");
  }
  const perMinutePerProject = input.perMinutePerProject ?? DRIVE_QUOTA.perMinutePerProject;
  const perMinutePerUser = input.perMinutePerUser ?? DRIVE_QUOTA.perMinutePerUserPerProject;
  const perDayBillingUnits = input.perDayBillingUnits ?? DRIVE_QUOTA.perDayBillingUnits;
  const callsPerMinutePerDevice = 60 / input.intervalSeconds;
  const callsPerDayPerDevice = 86_400 / input.intervalSeconds;
  const unitsPerMinutePerDevice = callsPerMinutePerDevice * input.unitsPerCall;
  const unitsPerMinuteSameUser = unitsPerMinutePerDevice * input.devices;
  const unitsPerDaySameUser = callsPerDayPerDevice * input.devices * input.unitsPerCall;
  return {
    intervalSeconds: input.intervalSeconds,
    devices: input.devices,
    unitsPerCall: input.unitsPerCall,
    callsPerMinutePerDevice,
    callsPerDayPerDevice,
    unitsPerMinutePerDevice,
    unitsPerMinuteSameUser,
    unitsPerMinuteProject: unitsPerMinuteSameUser,
    unitsPerDaySameUser,
    userMinuteFraction: unitsPerMinuteSameUser / perMinutePerUser,
    projectMinuteFraction: unitsPerMinuteSameUser / perMinutePerProject,
    dayBillingFraction: unitsPerDaySameUser / perDayBillingUnits,
  };
}

export function quotaHeaders(headers: Record<string, string>): Record<string, string> {
  const matched: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/quota|ratelimit|rate-limit|retry-after/iu.test(key)) matched[key] = value;
  }
  return matched;
}

export interface RaceTally {
  success: number;
  conflict: number;
  other: number;
}

export function tallyRace(outcomes: readonly ("success" | "conflict" | "other")[]): RaceTally {
  const tally: RaceTally = { success: 0, conflict: 0, other: 0 };
  for (const outcome of outcomes) tally[outcome] += 1;
  return tally;
}

/** One winner and one ConflictError, nothing else. */
export function raceMatchesExpectation(tally: RaceTally): boolean {
  return tally.success === 1 && tally.conflict === 1 && tally.other === 0;
}

export function mergeIdsPreserved(
  actual: readonly string[],
  expected: readonly string[],
): { ok: boolean; missing: string[]; extra: string[] } {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !actualSet.has(id));
  const extra = actual.filter((id) => !expectedSet.has(id));
  const duplicated = actual.length !== actualSet.size;
  return { ok: missing.length === 0 && extra.length === 0 && !duplicated, missing, extra };
}

export type NativeCheckClass = "sharp" | "binding" | "model-unavailable" | "embedded" | "unknown";

/**
 * `native-check` returns `{ ok:false, error:"<stage>: ..." }` and drops the
 * sharp payload when embed fails. Stage `embed` means sharp already returned.
 */
export function classifyNativeCheckError(error: string): NativeCheckClass {
  const text = error.trim();
  if (text.startsWith("sharp:")) return "sharp";
  if (/dlopen|onnxruntime_binding|ERR_DLOPEN|Cannot find module/iu.test(text)) return "binding";
  if (text.startsWith("embed:")) return "model-unavailable";
  return "unknown";
}

export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

export function changeListHasFile(
  changes: readonly { fileId: string | null; removed: boolean }[],
  fileId: string,
): boolean {
  return changes.some((change) => change.fileId === fileId && !change.removed);
}

export function isQuotaStatus(status: number | null): status is 403 | 429 {
  return status === 403 || status === 429;
}

export function httpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.response?.status, candidate.status, candidate.code]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
