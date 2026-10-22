import type { Event } from "@you-brain/protocol";

import { foldEvents } from "../topics/fold.js";
import { computeDueReminders, type ReminderActionFact, type ReminderIssuedData } from "./due.js";
import { foldReminders } from "./fold.js";

export interface DueDeviceInput {
  deviceId: string;
  mainDevice: string | null;
  /** System notifications only. Generation does not read this flag. */
  notifications: boolean;
  events: readonly Event[];
  sessionUpdatedAt: Readonly<Record<string, string>>;
  activeLimit: number;
  historyDays: number;
  morningDigestTime: string;
  weeklyReviewDay: number;
  weeklyReviewTime: string;
  now: string;
  timeZoneOffsetMinutes: number;
  mergeLines?: readonly { fromName: string; intoName: string; reason: string }[];
}

export function dueRemindersForDevice(input: DueDeviceInput): ReminderIssuedData[] {
  if (input.mainDevice === null || input.mainDevice !== input.deviceId) return [];
  void input.notifications;
  return computeDueReminders({
    book: foldEvents(input.events),
    sessionUpdatedAt: input.sessionUpdatedAt,
    reminders: foldReminders(input.events),
    actions: reminderActions(input.events),
    activeLimit: input.activeLimit,
    historyDays: input.historyDays,
    morningDigestTime: input.morningDigestTime,
    weeklyReviewDay: input.weeklyReviewDay,
    weeklyReviewTime: input.weeklyReviewTime,
    now: input.now,
    timeZoneOffsetMinutes: input.timeZoneOffsetMinutes,
    ...(input.mergeLines ? { mergeLines: input.mergeLines } : {}),
  });
}

export function reminderActions(events: readonly Event[]): ReminderActionFact[] {
  const facts: ReminderActionFact[] = [];
  for (const event of events) {
    if (event.type !== "reminder.action") continue;
    facts.push({
      reminderId: event.data.reminderId,
      topicId: event.data.topicId,
      action: event.data.action,
      ts: event.ts,
    });
  }
  return facts;
}
