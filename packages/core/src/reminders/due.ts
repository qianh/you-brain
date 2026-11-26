import type { EventOf, ReminderAction } from "@you-brain/protocol";

import { YouBrainError } from "../domain/errors.js";
import type { ReminderRecord } from "../store/types.js";
import { deriveLastActive, partitionTopics } from "../topics/zones.js";
import type { TopicBook, ZonedTopic } from "../topics/types.js";
import { digestConclusions, digestFollowUps, hasUndatedDigestItems, MAX_DIGEST_CONCLUSIONS, occurrenceTime } from "./digest.js";
import { digestText, hasLegacyDigestWarning, historyText, staleText, weeklyText } from "./text.js";
import {
  isoWeekKey,
  localDateKey,
  localParts,
  shiftDays,
  timeReached,
  weekdayReached,
} from "./time.js";

export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Topics the weekly review names as worth following up.
 *
 * Archived topics with open todos used to get a reminder each: a few hundred topics
 * produced eighty of them in one week, which is noise rather than help — plenty of
 * conversations were one-off questions that need no follow-up. Instead the review names
 * the few that still look live, and only counts the rest.
 */
export const WEEKLY_FOLLOW_UPS = 3;

/** A topic untouched for longer than this is history, not something to chase. */
export const FOLLOW_UP_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const REMINDER_KIND = {
  stale: "stale",
  history: "history",
  morningDigest: "morning_digest",
  weeklyReview: "weekly_review",
} as const;

export interface ReminderActionFact {
  reminderId: string;
  topicId: string | null;
  action: ReminderAction;
  ts: string;
}

export type DigestSnapshot = NonNullable<EventOf<"reminder.issued">["data"]["digestConclusions"]>;

export interface ReminderIssuedData {
  reminderId: string;
  kind: string;
  topicId: string | null;
  text: string;
  digestConclusions?: DigestSnapshot;
}

export interface ComputeDueInput {
  book: TopicBook;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  sourceSessionUpdatedAt?: Readonly<Record<string, string>>;
  pendingMorningRefine?: boolean;
  reminders: readonly ReminderRecord[];
  getMorningDigestSnapshot?: (reminderId: string) => DigestSnapshot | undefined;
  actions: readonly ReminderActionFact[];
  activeLimit: number;
  historyDays: number;
  morningDigestTime: string;
  weeklyReviewDay: number;
  weeklyReviewTime: string;
  now: string;
  timeZoneOffsetMinutes: number;
  mergeLines?: readonly { fromName: string; intoName: string; reason: string }[];
  /** 当天早报已发过也按当前数据重算一份(同一 id 再发,折叠时覆盖正文)。 */
  regenerateMorningDigest?: boolean;
}

export function computeDueReminders(input: ComputeDueInput): ReminderIssuedData[] {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new YouBrainError("INVALID_INPUT", "now must be an ISO-8601 timestamp");
  }
  if (!Number.isFinite(input.timeZoneOffsetMinutes)) {
    throw new YouBrainError("INVALID_INPUT", "time zone offset must be a finite number of minutes");
  }
  const parts = localParts(nowMs, input.timeZoneOffsetMinutes);
  const zoned = partitionTopics(input.book, {
    now: input.now,
    activeLimit: input.activeLimit,
    historyDays: input.historyDays,
    sessionUpdatedAt: input.sessionUpdatedAt,
    // A stale reminder's id embeds this date, so dismissing one must move it forward.
    countReminderActions: true,
  });
  const openTodos = countOpenTodos(input.book);
  const existing = new Set(input.reminders.map((item) => item.reminderId));
  const due: ReminderIssuedData[] = [];

  for (const topic of zoned.active) {
    const count = openTodos.get(topic.topicId) ?? 0;
    if (count === 0 || topic.lastActive === null) continue;
    const lastMs = Date.parse(topic.lastActive);
    if (Number.isNaN(lastMs) || nowMs - lastMs < STALE_MS) continue;
    if (blocked(topic, input, nowMs)) continue;
    const reminderId = `stale:${topic.topicId}:${localDateKey(localParts(lastMs, input.timeZoneOffsetMinutes))}`;
    if (existing.has(reminderId)) continue;
    due.push({
      reminderId,
      kind: REMINDER_KIND.stale,
      topicId: topic.topicId,
      text: staleText(topic.name, count),
    });
  }

  const week = isoWeekKey(parts);
  if (weekdayReached(parts, input.weeklyReviewDay, input.weeklyReviewTime)) {
    const weeklyId = `weekly:${week}`;
    if (!existing.has(weeklyId)) {
      due.push({
        reminderId: weeklyId,
        kind: REMINDER_KIND.weeklyReview,
        topicId: null,
        text: weeklyBody(input, zoned.active, zoned.history, openTodos, week),
      });
    }
  }

  if (timeReached(parts, input.morningDigestTime)) {
    const morningId = `morning:${localDateKey(parts)}`;
    const previous = input.reminders.find((item) => item.reminderId === morningId);
    const previousSnapshot = previous ? input.getMorningDigestSnapshot?.(morningId) : undefined;
    if (input.regenerateMorningDigest === true || !previous || previousSnapshot?.incomplete || hasLegacyDigestWarning(previous.text)) {
      const body = morningBody(input, nowMs, parts);
      if (input.regenerateMorningDigest === true || previous?.text !== body.text || !sameDigestSnapshot(previousSnapshot, body.digestConclusions)) {
        due.push({ reminderId: morningId, kind: REMINDER_KIND.morningDigest, topicId: null, ...body });
      }
    }
  }

  due.sort((left, right) =>
    left.reminderId < right.reminderId ? -1 : left.reminderId > right.reminderId ? 1 : 0,
  );
  return due;
}

function blocked(topic: ZonedTopic, input: ComputeDueInput, nowMs: number): boolean {
  if (snoozeActive(input.reminders, topic.topicId, nowMs)) return true;
  const control = topicControl(topic.topicId, topic.lastActive, input);
  return control.muted || control.ignored;
}

function snoozeActive(
  reminders: readonly ReminderRecord[],
  topicId: string,
  nowMs: number,
): boolean {
  return reminders.some((reminder) => {
    if (reminder.topicId !== topicId || reminder.status !== "snoozed" || reminder.until === null) {
      return false;
    }
    const until = Date.parse(reminder.until);
    return !Number.isNaN(until) && until > nowMs;
  });
}

/**
 * Whether the user muted this topic and has not touched it since.
 * The same rule the generated reminders follow; recall reminders defer to it too.
 */
export function topicIsMuted(
  topicId: string,
  input: Pick<ComputeDueInput, "book" | "sessionUpdatedAt" | "actions">,
): boolean {
  const lastActive = deriveLastActive(input.book, input.sessionUpdatedAt, {
    countReminderActions: true,
  }).get(topicId);
  return topicControl(topicId, lastActive ?? null, input).muted;
}

function topicControl(
  topicId: string,
  lastActive: string | null,
  input: Pick<ComputeDueInput, "book" | "sessionUpdatedAt" | "actions">,
): { muted: boolean; ignored: boolean } {
  const marks: Array<{ ts: string; kind: "session" | "reset" | "mute" | "ignore" }> = [];
  for (const action of input.actions) {
    if (action.topicId !== topicId) continue;
    if (action.action === "ignore") marks.push({ ts: action.ts, kind: "ignore" });
    else if (action.action === "mute") marks.push({ ts: action.ts, kind: "mute" });
    else marks.push({ ts: action.ts, kind: "reset" });
  }
  for (const session of input.book.sessions) {
    if (session.topicId !== topicId) continue;
    const at = input.sessionUpdatedAt[session.sessionKey];
    if (at !== undefined) marks.push({ ts: at, kind: "session" });
  }
  marks.sort((left, right) => {
    const delta = Date.parse(left.ts) - Date.parse(right.ts);
    if (delta !== 0) return delta;
    return markOrder(left.kind) - markOrder(right.kind);
  });

  let streak = 0;
  let blockedAt: string | null = null;
  let muteAt: string | null = null;
  for (const mark of marks) {
    if (mark.kind === "session" || mark.kind === "reset") {
      streak = 0;
      if (blockedAt !== null && Date.parse(mark.ts) > Date.parse(blockedAt)) blockedAt = null;
      continue;
    }
    if (mark.kind === "mute") {
      if (muteAt === null || Date.parse(mark.ts) > Date.parse(muteAt)) muteAt = mark.ts;
      continue;
    }
    if (blockedAt !== null && Date.parse(mark.ts) >= Date.parse(blockedAt)) continue;
    streak += 1;
    if (streak >= 3) {
      blockedAt = mark.ts;
      streak = 0;
    }
  }

  const lastMs = lastActive === null ? null : Date.parse(lastActive);
  const muted =
    muteAt !== null && (lastMs === null || Number.isNaN(lastMs) || lastMs <= Date.parse(muteAt));
  return { muted, ignored: blockedAt !== null };
}

function markOrder(kind: "session" | "reset" | "mute" | "ignore"): number {
  switch (kind) {
    case "session":
      return 0;
    case "reset":
      return 1;
    case "mute":
      return 2;
    case "ignore":
      return 3;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** 早报「建议跟进」只列优先级最高的几个话题。 */
const DIGEST_SUGGESTION_LIMIT = 5;

function morningBody(
  input: ComputeDueInput,
  nowMs: number,
  parts: ReturnType<typeof localParts>,
): { text: string; digestConclusions: DigestSnapshot } {
  const day = {
    book: input.book,
    day: localDateKey(shiftDays(parts, -1)),
    offsetMinutes: input.timeZoneOffsetMinutes,
    sourceSessionUpdatedAt: input.sourceSessionUpdatedAt ?? input.sessionUpdatedAt,
    asOf: nowMs,
  };
  const conclusions = digestConclusions(day);
  return {
    text: digestText({
      conclusions: conclusions.map((item) => item.text),
      ...digestFollowUps(day, DIGEST_SUGGESTION_LIMIT),
    }),
    digestConclusions: {
      ids: conclusions.slice(0, MAX_DIGEST_CONCLUSIONS).map((item) => item.conclusionId),
      total: conclusions.length,
      ...(input.pendingMorningRefine || hasUndatedDigestItems(day) ? { incomplete: true } : {}),
    },
  };
}

function sameDigestSnapshot(previous: DigestSnapshot | undefined, current: DigestSnapshot): boolean {
  return previous !== undefined && previous.incomplete === current.incomplete && previous.total === current.total &&
    previous.ids.length === current.ids.length && previous.ids.every((id, index) => id === current.ids[index]);
}

function weeklyBody(
  input: ComputeDueInput,
  active: readonly ZonedTopic[],
  history: readonly ZonedTopic[],
  openTodos: ReadonlyMap<string, number>,
  week: string,
): string {
  const visible = [...active, ...history];
  const lastContent = deriveLastActive(input.book, input.sessionUpdatedAt);
  const activeCount = visible.filter((topic) =>
    inWeek(lastContent.get(topic.topicId) ?? null, week, input.timeZoneOffsetMinutes),
  ).length;
  const nowMs = Date.parse(input.now);
  const sourceDates = input.sourceSessionUpdatedAt ?? input.sessionUpdatedAt;
  const conclusionCount = input.book.conclusions.filter((item) => {
    const occurred = occurrenceTime(item, sourceDates, input.timeZoneOffsetMinutes);
    return Date.parse(item.ts) <= nowMs && occurred <= nowMs &&
      isoWeekKey(localParts(occurred, input.timeZoneOffsetMinutes)) === week;
  }).length;
  const staleNames = active
    .filter((topic) => {
      if ((openTodos.get(topic.topicId) ?? 0) === 0 || topic.lastActive === null) return false;
      const lastMs = Date.parse(topic.lastActive);
      return !Number.isNaN(lastMs) && nowMs - lastMs >= STALE_MS;
    })
    .map((topic) => topic.name);
  // Worth following up: archived topics that still have open todos and were touched
  // recently. Everything older is counted, not named — a conversation from last year is
  // not a task, and naming each one turned the review into a wall of text.
  const withTodos = history.flatMap((topic) => {
    const count = openTodos.get(topic.topicId) ?? 0;
    if (count === 0) return [];
    const lastMs = topic.lastActive === null ? Number.NaN : Date.parse(topic.lastActive);
    return [{ topic, count, lastMs: Number.isNaN(lastMs) ? Number.NEGATIVE_INFINITY : lastMs }];
  });
  const followUps = withTodos
    .filter((item) => nowMs - item.lastMs <= FOLLOW_UP_WINDOW_MS)
    .filter((item) => !blocked(item.topic, input, nowMs))
    .sort(
      (left, right) =>
        right.count - left.count ||
        right.lastMs - left.lastMs ||
        (left.topic.topicId < right.topic.topicId ? -1 : 1),
    )
    .slice(0, WEEKLY_FOLLOW_UPS)
    .map((item) => ({ name: item.topic.name, openTodos: item.count }));
  const olderCount = withTodos.length - followUps.length;
  return weeklyText({
    activeCount,
    conclusionCount,
    staleNames,
    followUps,
    olderCount,
    ...(input.mergeLines ? { mergeSuggestions: input.mergeLines } : {}),
  });
}

function inWeek(ts: string | null, week: string, offsetMinutes: number): boolean {
  if (ts === null) return false;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return false;
  return isoWeekKey(localParts(ms, offsetMinutes)) === week;
}

function countOpenTodos(book: TopicBook): Map<string, number> {
  const counts = new Map<string, number>();
  for (const todo of book.todos) {
    if (todo.status !== "open") continue;
    const topicId = liveTopicId(book, todo.topicId);
    counts.set(topicId, (counts.get(topicId) ?? 0) + 1);
  }
  return counts;
}

function liveTopicId(book: TopicBook, topicId: string): string {
  const byId = new Map(book.topics.map((topic) => [topic.topicId, topic]));
  let current = topicId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = byId.get(current)?.mergedInto;
    if (!next) return current;
    current = next;
  }
  return current;
}
