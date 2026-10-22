export const SNOOZE_DAYS = {
  tomorrow: 1,
  threeDays: 3,
  nextWeek: 7,
} as const;

export type SnoozeChoice = keyof typeof SNOOZE_DAYS;

export type ReminderActionName = "reactivate" | "done" | "snooze" | "mute" | "ignore";

const SNOOZE_HOUR = 9;

export function isDigestReminder(reminder: { kind: string; topicId: string | null }): boolean {
  return (
    reminder.topicId === null ||
    reminder.kind === "morning_digest" ||
    reminder.kind === "weekly_review"
  );
}

export function reminderFirstLine(text: string): { line: string; more: boolean } {
  const normalized = text.replaceAll("\r\n", "\n");
  const index = normalized.indexOf("\n");
  if (index < 0) return { line: normalized, more: false };
  return { line: normalized.slice(0, index), more: true };
}

export function reminderFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}

/** Local calendar date `days` ahead, at 09:00 in `timeZone`. */
export function snoozeUntil(now: Date, timeZone: string, days: number): string {
  const offset = zoneOffsetMinutes(timeZone, now);
  const local = new Date(now.getTime() + offset * 60_000);
  const wall = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + days,
    SNOOZE_HOUR,
    0,
    0,
  );
  let instant = wall - offset * 60_000;
  const shifted = zoneOffsetMinutes(timeZone, new Date(instant));
  if (shifted !== offset) instant = wall - shifted * 60_000;
  return new Date(instant).toISOString();
}

export function snoozeChoiceUntil(now: Date, timeZone: string, choice: SnoozeChoice): string {
  return snoozeUntil(now, timeZone, SNOOZE_DAYS[choice]);
}

function zoneOffsetMinutes(timeZone: string, now: Date): number {
  try {
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
    if (!Number.isFinite(asUtc)) return 0;
    return Math.round((asUtc - now.getTime()) / 60_000);
  } catch {
    return 0;
  }
}
