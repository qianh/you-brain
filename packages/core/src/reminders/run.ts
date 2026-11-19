import type { Event } from "@you-brain/protocol";

import { foldEventsCached } from "../topics/book-cache.js";
import {
  REMINDER_KIND,
  computeDueReminders,
  type ComputeDueInput,
  type ReminderActionFact,
  type ReminderIssuedData,
} from "./due.js";
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
  if (!isMainDevice(input)) return [];
  return computeDueReminders(computeInput(input));
}

/**
 * 按当前数据重算今天的早报,沿用原 id。只有主设备生成;还没到早报时间时为 null。
 * 只返回早报这一条,其余到期提醒仍由定时任务发。
 */
export function regenerateMorningDigestForDevice(
  input: DueDeviceInput,
): ReminderIssuedData | null {
  if (!isMainDevice(input)) return null;
  return (
    computeDueReminders({ ...computeInput(input), regenerateMorningDigest: true }).find(
      (item) => item.kind === REMINDER_KIND.morningDigest,
    ) ?? null
  );
}

export function isMainDevice(input: Pick<DueDeviceInput, "deviceId" | "mainDevice">): boolean {
  return input.mainDevice !== null && input.mainDevice === input.deviceId;
}

function computeInput(input: DueDeviceInput): ComputeDueInput {
  void input.notifications;
  return {
    book: foldEventsCached(input.events),
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
  };
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
