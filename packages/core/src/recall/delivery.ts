import { createHash } from "node:crypto";

import { localDayKey } from "../consolidate/schedule.js";
import type { ReminderRecord } from "../store/types.js";
import {
  RECALL_DAILY_LIMIT,
  RECALL_KIND,
  RECALL_LATE_MS,
  RECALL_TOPIC_COOLDOWN_MS,
  type RecallGrade,
  type RecallKind,
} from "./types.js";

/** One session raises at most one reminder per topic, however many times it is considered. */
export function recallReminderId(sessionKey: string, topicId: string): string {
  return `recall:${createHash("sha1").update(`${sessionKey}\n${topicId}`).digest("hex").slice(0, 16)}`;
}

export interface RecallDeliveryInput {
  grade: RecallGrade;
  /** Time from the trigger to the model's answer. */
  elapsedMs: number;
  stillOnTopic: boolean;
  topicId: string;
  reminders: readonly ReminderRecord[];
  nowMs: number;
  timeZone: string;
}

export type RecallDeliveryReason = "ok" | "late" | "topic-cooldown" | "daily-limit";

/**
 * An important reminder is always delivered, whatever the clock or the counters say.
 * A normal one waits out the topic cooldown and the daily limit, and when the answer
 * came late for someone who has moved on it is listed without a notification.
 * A reminder the user dismissed still counts as one that was sent.
 */
export function decideRecallDelivery(input: RecallDeliveryInput): {
  kind: RecallKind | null;
  reason: RecallDeliveryReason;
} {
  if (input.grade === "important") return { kind: RECALL_KIND.notify, reason: "ok" };
  const sent = input.reminders.filter(
    (item) => item.kind === RECALL_KIND.notify || item.kind === RECALL_KIND.quiet,
  );
  const cooling = sent.some((item) => {
    if (item.topicId !== input.topicId) return false;
    const issued = Date.parse(item.issuedAt);
    return !Number.isNaN(issued) && input.nowMs - issued < RECALL_TOPIC_COOLDOWN_MS;
  });
  if (cooling) return { kind: null, reason: "topic-cooldown" };
  const today = localDayKey(new Date(input.nowMs), input.timeZone);
  const todayCount = sent.filter((item) => {
    const issued = Date.parse(item.issuedAt);
    return !Number.isNaN(issued) && localDayKey(new Date(issued), input.timeZone) === today;
  }).length;
  if (todayCount >= RECALL_DAILY_LIMIT) return { kind: null, reason: "daily-limit" };
  if (input.elapsedMs > RECALL_LATE_MS && !input.stillOnTopic) {
    return { kind: RECALL_KIND.quiet, reason: "late" };
  }
  return { kind: RECALL_KIND.notify, reason: "ok" };
}
