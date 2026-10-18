import { YouBrainError } from "../domain/errors.js";

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new YouBrainError("INVALID_INPUT", `Invalid time zone: ${timeZone}`);
  }
}

function wallTime(timeZone: string, instant: Date): WallTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const bag = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "literal") bag.set(part.type, part.value);
  }
  const year = Number(bag.get("year"));
  const month = Number(bag.get("month"));
  const day = Number(bag.get("day"));
  let hour = Number(bag.get("hour"));
  const minute = Number(bag.get("minute"));
  const second = Number(bag.get("second"));
  if (![year, month, day, hour, minute, second].every((value) => Number.isFinite(value))) {
    throw new YouBrainError("INVALID_INPUT", `Invalid time zone: ${timeZone}`);
  }
  if (hour === 24) {
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    return {
      year: rolled.getUTCFullYear(),
      month: rolled.getUTCMonth() + 1,
      day: rolled.getUTCDate(),
      hour: 0,
      minute,
      second,
    };
  }
  return { year, month, day, hour, minute, second };
}

function instantFromWall(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const want = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = want;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const wall = wallTime(timeZone, new Date(guess));
    const got = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
    );
    const delta = got - want;
    if (delta === 0) return guess;
    guess -= delta;
  }
  return guess;
}

export function zonedDayRange(
  now: Date,
  timeZone: string,
): { startMs: number; endMs: number } {
  if (Number.isNaN(now.getTime())) {
    throw new YouBrainError("INVALID_INPUT", "now must be a valid timestamp");
  }
  assertTimeZone(timeZone);
  const wall = wallTime(timeZone, now);
  return {
    startMs: instantFromWall(timeZone, wall.year, wall.month, wall.day),
    endMs: instantFromWall(timeZone, wall.year, wall.month, wall.day + 1),
  };
}

export function parseTimestamp(value: string, field: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new YouBrainError("INVALID_INPUT", `${field} must be an ISO-8601 timestamp`);
  }
  return ms;
}
