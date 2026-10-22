import { YouBrainError } from "../domain/errors.js";

const DAY_MS = 86_400_000;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

export interface ParsedSearchRange {
  sinceMs: number | null;
  untilMs: number | null;
}

/**
 * `since` / `until` are the search service's names for API `from` / `to`.
 * A date-only `from` is that UTC day at 00:00:00.000 inclusive.
 * A date-only `to` includes the whole UTC day, through 23:59:59.999.
 * Datetimes must carry `Z` or a numeric offset. Anything else throws.
 */
export function parseSearchRange(input: { since?: string; until?: string }): ParsedSearchRange {
  return {
    sinceMs: bound(input.since, "from", "start"),
    untilMs: bound(input.until, "to", "end"),
  };
}

/** Validate API `from` / `to` before search runs. Empty strings are absent, not errors. */
export function assertSearchRange(query: { from?: string; to?: string }): void {
  const input: { since?: string; until?: string } = {};
  if (query.from !== undefined && query.from.length > 0) input.since = query.from;
  if (query.to !== undefined && query.to.length > 0) input.until = query.to;
  parseSearchRange(input);
}

/**
 * Compare a stored `updated_at` to the parsed bounds.
 * With no bounds, every row matches. An unparseable timestamp is dropped once a bound is set.
 */
export function updatedAtInRange(updatedAt: string, range: ParsedSearchRange): boolean {
  if (range.sinceMs === null && range.untilMs === null) return true;
  const at = parseInstant(updatedAt);
  if (at === null) return false;
  if (range.sinceMs !== null && at < range.sinceMs) return false;
  if (range.untilMs !== null && at > range.untilMs) return false;
  return true;
}

function bound(value: string | undefined, label: "from" | "to", edge: "start" | "end"): number | null {
  if (value === undefined) return null;
  const date = DATE_ONLY.exec(value);
  if (date) {
    const year = numberAt(date, 1);
    const month = numberAt(date, 2);
    const day = numberAt(date, 3);
    if (!validCalendar(year, month, day)) invalid(label, value);
    const start = Date.UTC(year, month - 1, day);
    return edge === "start" ? start : start + DAY_MS - 1;
  }
  const instant = parseInstant(value);
  if (instant === null) invalid(label, value);
  return instant;
}

function parseInstant(value: string): number | null {
  const match = INSTANT.exec(value);
  if (!match) return null;
  const year = numberAt(match, 1);
  const month = numberAt(match, 2);
  const day = numberAt(match, 3);
  const hour = numberAt(match, 4);
  const minute = numberAt(match, 5);
  const second = numberAt(match, 6);
  if (!validCalendar(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  const fraction = match[7] ?? "";
  const ms = fraction === "" ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));
  if (!Number.isFinite(ms)) return null;
  const zone = match[8] ?? "";
  const offset = zone === "Z" ? 0 : offsetMinutes(zone);
  if (offset === null) return null;
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset * 60_000;
}

function offsetMinutes(zone: string): number | null {
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(zone);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = numberAt(match, 2);
  const minutes = numberAt(match, 3);
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

function numberAt(match: RegExpExecArray, index: number): number {
  return Number(match[index] ?? "");
}

function validCalendar(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function invalid(label: "from" | "to", value: string): never {
  throw new YouBrainError("INVALID_INPUT", `${label} 不是合法的 ISO 日期或带时区的时间：${value}`);
}
