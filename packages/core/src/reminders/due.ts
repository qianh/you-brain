import type { ReminderAction } from "@you-brain/protocol";

import { YouBrainError } from "../domain/errors.js";
import type { ReminderRecord } from "../store/types.js";
import { partitionTopics } from "../topics/zones.js";
import type { TopicBook, ZonedTopic } from "../topics/types.js";
import { digestText, historyText, staleText, weeklyText } from "./text.js";
import {
  isoWeekKey,
  localDateKey,
  localParts,
  shiftDays,
  timeReached,
  weekdayReached,
} from "./time.js";

export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

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

export interface ReminderIssuedData {
  reminderId: string;
  kind: string;
  topicId: string | null;
  text: string;
}

export interface ComputeDueInput {
  book: TopicBook;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  reminders: readonly ReminderRecord[];
  actions: readonly ReminderActionFact[];
  activeLimit: number;
  historyDays: number;
  morningDigestTime: string;
  weeklyReviewDay: number;
  weeklyReviewTime: string;
  now: string;
  timeZoneOffsetMinutes: number;
  mergeLines?: readonly { fromName: string; intoName: string; reason: string }[];
}

interface RankedTopic {
  topic: ZonedTopic;
  priority: number;
  lastMs: number;
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
    for (const topic of zoned.history) {
      const count = openTodos.get(topic.topicId) ?? 0;
      if (count === 0 || blocked(topic, input, nowMs)) continue;
      const reminderId = `history:${topic.topicId}:${week}`;
      if (existing.has(reminderId)) continue;
      due.push({
        reminderId,
        kind: REMINDER_KIND.history,
        topicId: topic.topicId,
        text: historyText(topic.name, count),
      });
    }
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
    if (!existing.has(morningId)) {
      due.push({
        reminderId: morningId,
        kind: REMINDER_KIND.morningDigest,
        topicId: null,
        text: morningBody(input, [...zoned.active, ...zoned.history], openTodos, nowMs, parts),
      });
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

function topicControl(
  topicId: string,
  lastActive: string | null,
  input: ComputeDueInput,
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

function morningBody(
  input: ComputeDueInput,
  topics: readonly ZonedTopic[],
  openTodos: ReadonlyMap<string, number>,
  nowMs: number,
  parts: ReturnType<typeof localParts>,
): string {
  const yesterday = localDateKey(shiftDays(parts, -1));
  const conclusions = input.book.conclusions
    .filter((item) => localDateKey(localParts(Date.parse(item.ts), input.timeZoneOffsetMinutes)) === yesterday)
    .sort((left, right) => {
      if (left.ts !== right.ts) return left.ts < right.ts ? 1 : -1;
      return left.conclusionId < right.conclusionId ? -1 : 1;
    })
    .map((item) => item.text);
  const openTodoCount = input.book.todos.filter((todo) => todo.status === "open").length;
  const suggestions = rankSuggestions(topics, openTodos, nowMs)
    .slice(0, 3)
    .map((topic) => topic.name);
  return digestText({ conclusions, openTodoCount, suggestions });
}

function weeklyBody(
  input: ComputeDueInput,
  active: readonly ZonedTopic[],
  history: readonly ZonedTopic[],
  openTodos: ReadonlyMap<string, number>,
  week: string,
): string {
  const visible = [...active, ...history];
  const activeCount = visible.filter((topic) =>
    inWeek(topic.lastActive, week, input.timeZoneOffsetMinutes),
  ).length;
  const conclusionCount = input.book.conclusions.filter((item) =>
    inWeek(item.ts, week, input.timeZoneOffsetMinutes),
  ).length;
  const nowMs = Date.parse(input.now);
  const staleNames = active
    .filter((topic) => {
      if ((openTodos.get(topic.topicId) ?? 0) === 0 || topic.lastActive === null) return false;
      const lastMs = Date.parse(topic.lastActive);
      return !Number.isNaN(lastMs) && nowMs - lastMs >= STALE_MS;
    })
    .map((topic) => topic.name);
  const historyNames = history
    .filter((topic) => (openTodos.get(topic.topicId) ?? 0) > 0)
    .map((topic) => topic.name);
  return weeklyText({
    activeCount,
    conclusionCount,
    staleNames,
    historyNames,
    ...(input.mergeLines ? { mergeSuggestions: input.mergeLines } : {}),
  });
}

function rankSuggestions(
  topics: readonly ZonedTopic[],
  openTodos: ReadonlyMap<string, number>,
  nowMs: number,
): ZonedTopic[] {
  const ranked: RankedTopic[] = [];
  for (const topic of topics) {
    if ((openTodos.get(topic.topicId) ?? 0) === 0) continue;
    const lastMs =
      topic.lastActive === null || Number.isNaN(Date.parse(topic.lastActive))
        ? Number.NEGATIVE_INFINITY
        : Date.parse(topic.lastActive);
    const stale = lastMs !== Number.NEGATIVE_INFINITY && nowMs - lastMs >= STALE_MS;
    ranked.push({
      topic,
      priority: stale || topic.status === "follow_up" ? 0 : 1,
      lastMs,
    });
  }
  ranked.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.lastMs !== right.lastMs) return right.lastMs - left.lastMs;
    return left.topic.topicId < right.topic.topicId ? -1 : 1;
  });
  return ranked.map((item) => item.topic);
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
