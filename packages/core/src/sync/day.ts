import { YouBrainError } from "../domain/errors.js";
import { zonedDayRange } from "../store/time.js";

export function zonedDay(instant: Date, timeZone: string): string {
  let startMs: number;
  try {
    startMs = zonedDayRange(instant, timeZone).startMs;
  } catch (error) {
    if (error instanceof YouBrainError) throw error;
    throw new YouBrainError("INVALID_INPUT", `Invalid time zone: ${timeZone}`);
  }
  // Local midnight can be reported as the previous date at hour 24.
  const probe = new Date(startMs + 60_000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(probe);
  const bag = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "literal") bag.set(part.type, part.value);
  }
  const year = bag.get("year");
  const month = bag.get("month");
  const day = bag.get("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new YouBrainError("INVALID_INPUT", `Invalid time zone: ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}
