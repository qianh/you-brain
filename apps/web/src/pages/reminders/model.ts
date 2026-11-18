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

/** A reminder raised because the user was talking about its topic, loud or quiet. */
export function isRecallReminder(reminder: { kind: string }): boolean {
  return reminder.kind === "recall" || reminder.kind === "recall_quiet";
}

export function reminderFirstLine(text: string): { line: string; more: boolean } {
  const normalized = text.replaceAll("\r\n", "\n");
  const index = normalized.indexOf("\n");
  if (index < 0) return { line: normalized, more: false };
  return { line: normalized.slice(0, index), more: true };
}

/**
 * 晨间摘要正文是 core 按固定句式拼的(packages/core/src/reminders/text.ts digestText),
 * 第一条结论为了系统通知被截成二十几个字。卡片上只取数字和建议跟进的话题,结论原文走详情。
 * 句式认不出(旧格式或改过文案)时返回 null,卡片退回原文显示。
 */
export interface DigestSummary {
  conclusions: number;
  todos: number;
  suggestions: string[];
}

export function parseDigest(text: string): DigestSummary | null {
  let conclusions: number | undefined;
  let todos: number | undefined;
  let suggestions: string[] = [];
  for (const raw of text.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const many = /^昨日结论 (\d+) 条：/u.exec(line);
    const todo = /^未完成待办 (\d+) 件。$/u.exec(line);
    if (line === "昨日没有新结论。") conclusions = 0;
    else if (many) conclusions = Number(many[1]);
    else if (line.startsWith("昨日结论：")) conclusions = 1;
    else if (line === "没有未完成的待办。") todos = 0;
    else if (todo) todos = Number(todo[1]);
    else if (line === "今天没有特别建议跟进的话题。") suggestions = [];
    else if (line.startsWith("建议跟进：")) suggestions = splitNames(line.slice("建议跟进：".length));
    else return null;
  }
  if (conclusions === undefined || todos === undefined) return null;
  return { conclusions, todos, suggestions };
}

/** 详情接口返回的结论全文(packages/core/src/reminders/detail.ts),拆成列表项。 */
export interface DigestDetail {
  conclusions: Array<{ text: string; topic: string | null }>;
  note: string | null;
  suggestions: string[];
}

export function parseDigestDetail(detail: string): DigestDetail | null {
  const conclusions: DigestDetail["conclusions"] = [];
  const suggestions: string[] = [];
  let note: string | null = null;
  for (const raw of detail.replaceAll("\r\n", "\n").split("\n")) {
    const line = raw.trim();
    if (line === "" || line === "建议跟进" || line === "昨日没有新结论。" || /^昨日结论（\d+ 条）$/u.test(line)) continue;
    const item = /^\d+\. (.*)$/u.exec(line);
    if (item) {
      const body = item[1] ?? "";
      const cut = body.lastIndexOf("  —— ");
      conclusions.push(
        cut < 0 ? { text: body, topic: null } : { text: body.slice(0, cut).trim(), topic: body.slice(cut + 5).trim() || null },
      );
    } else if (line.startsWith("· ")) suggestions.push(line.slice(2).trim());
    else if (line.startsWith("……")) note = line.slice(2).trim();
    else return null;
  }
  return { conclusions, note, suggestions };
}

function splitNames(value: string): string[] {
  return value
    .replace(/。$/u, "")
    .split("、")
    .map((name) => name.trim())
    .filter((name) => name !== "");
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
