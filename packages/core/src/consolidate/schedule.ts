import {
  localDateKey,
  localParts,
  shiftDays,
  timeReached,
  timeZoneOffsetMinutes,
} from "../reminders/time.js";

export const MAX_CATCH_UP_DAYS = 7;
export const BACKOFF_INITIAL_MS = 30 * 60 * 1000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export const CONSOLIDATION_BLOCKS = [
  "NOT_MAIN_DEVICE",
  "DISABLED",
  "NO_LLM",
  "NO_DRIVE",
] as const;

export type ConsolidationBlock = (typeof CONSOLIDATION_BLOCKS)[number];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function consolidationBlock(input: {
  deviceId: string;
  mainDevice: string | null;
  enabled: boolean;
  hasLlm: boolean;
  hasDrive: boolean;
}): ConsolidationBlock | null {
  if (input.mainDevice === null || input.mainDevice !== input.deviceId) return "NOT_MAIN_DEVICE";
  if (!input.enabled) return "DISABLED";
  if (!input.hasLlm) return "NO_LLM";
  if (!input.hasDrive) return "NO_DRIVE";
  return null;
}

export function nextBackoffMs(previousMs: number): number {
  if (!Number.isFinite(previousMs) || previousMs <= 0) return BACKOFF_INITIAL_MS;
  return Math.min(previousMs * 2, BACKOFF_MAX_MS);
}

export function localDayKey(instant: Date, timeZone: string): string {
  const offset = timeZoneOffsetMinutes(timeZone, instant);
  return localDateKey(localParts(instant.getTime(), offset));
}

export function consolidationTimeDue(now: Date, timeZone: string, time: string): boolean {
  try {
    const offset = timeZoneOffsetMinutes(timeZone, now);
    return timeReached(localParts(now.getTime(), offset), time);
  } catch {
    return false;
  }
}

export function instantOnLocalDay(iso: string, day: string, timeZone: string): boolean {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  try {
    return localDayKey(new Date(ms), timeZone) === day;
  } catch {
    return false;
  }
}

export function shiftDateKey(day: string, days: number): string {
  const match = DAY.exec(day);
  if (!match) throw new Error("invalid day");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  return localDateKey(shiftDays({ year, month, day: date }, days));
}

/**
 * Days to process, oldest first.
 * No lease: today only. Otherwise `(leaseDate, today]`, capped at the last 7 dates.
 * `force` reruns today when that date is already leased.
 */
export function planConsolidationDays(input: {
  leaseDate: string | null;
  today: string;
  force?: boolean;
}): string[] {
  if (!DAY.test(input.today)) return [];
  if (input.leaseDate === null || !DAY.test(input.leaseDate)) return [input.today];
  if (input.leaseDate > input.today) return input.force ? [input.today] : [];
  if (input.leaseDate === input.today) return input.force ? [input.today] : [];
  const earliest = shiftDateKey(input.today, -(MAX_CATCH_UP_DAYS - 1));
  let cursor = shiftDateKey(input.leaseDate, 1);
  if (cursor < earliest) cursor = earliest;
  const days: string[] = [];
  while (cursor <= input.today && days.length < MAX_CATCH_UP_DAYS) {
    days.push(cursor);
    cursor = shiftDateKey(cursor, 1);
  }
  return days;
}
