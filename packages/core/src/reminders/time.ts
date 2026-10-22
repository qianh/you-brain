export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** Monday is 1, Sunday is 7. */
  isoWeekday: number;
}

export function localParts(instantMs: number, offsetMinutes: number): LocalParts {
  const shifted = new Date(instantMs + offsetMinutes * 60_000);
  const weekday = shifted.getUTCDay();
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    isoWeekday: weekday === 0 ? 7 : weekday,
  };
}

export function localDateKey(parts: Pick<LocalParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function shiftDays(
  parts: Pick<LocalParts, "year" | "month" | "day">,
  days: number,
): Pick<LocalParts, "year" | "month" | "day"> {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** ISO week of a local calendar date, `YYYY-Www`. */
export function isoWeekKey(parts: Pick<LocalParts, "year" | "month" | "day">): string {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const start = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((date.getTime() - start) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

export function timeReached(parts: LocalParts, time: string): boolean {
  const parsed = parseClock(time);
  if (!parsed) return false;
  if (parts.hour !== parsed.hour) return parts.hour > parsed.hour;
  return parts.minute >= parsed.minute;
}

/** `day` is 1 (Monday) through 7 (Sunday), matching the shared config. */
export function weekdayReached(parts: LocalParts, day: number, time: string): boolean {
  if (!Number.isInteger(day) || day < 1 || day > 7) return false;
  if (parts.isoWeekday > day) return true;
  if (parts.isoWeekday < day) return false;
  return timeReached(parts, time);
}

/** Minutes east of UTC for an IANA zone at `now`. */
export function timeZoneOffsetMinutes(timeZone: string, now: Date): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const bag = new Map<string, string>();
  for (const part of formatted) {
    if (part.type !== "literal") bag.set(part.type, part.value);
  }
  let hour = bag.get("hour") ?? "00";
  if (hour === "24") hour = "00";
  const asUtc = Date.UTC(
    Number(bag.get("year")),
    Number(bag.get("month")) - 1,
    Number(bag.get("day")),
    Number(hour),
    Number(bag.get("minute")),
    Number(bag.get("second")),
  );
  return Math.round((asUtc - now.getTime()) / 60_000);
}

function parseClock(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
