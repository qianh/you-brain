import type { ReminderAction } from "@you-brain/protocol";

import type { ReminderView, UserEvent } from "../http/types.js";
import { effectiveStatus } from "./present.js";
import { REMINDER_KIND } from "./due.js";
import { statusForAction } from "./fold.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReminderActionPlan {
  events: UserEvent[];
  reminder: ReminderView;
}

export function planReminderAction(input: {
  reminder: ReminderView;
  action: ReminderAction;
  until: string | null;
  now: string;
}): ReminderActionPlan | { error: { status: 400; code: "INVALID_INPUT"; message: string } } {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    return { error: { status: 400, code: "INVALID_INPUT", message: "时间无效" } };
  }
  const digest =
    input.reminder.kind === REMINDER_KIND.morningDigest ||
    input.reminder.kind === REMINDER_KIND.weeklyReview;
  if ((digest || input.reminder.topicId === null) && input.action !== "ignore") {
    return {
      error: { status: 400, code: "INVALID_INPUT", message: "这条提醒只能关闭" },
    };
  }
  const until =
    input.action === "snooze" ? (input.until ?? new Date(nowMs + DAY_MS).toISOString()) : null;
  const topicId = input.reminder.topicId;
  const events: UserEvent[] = [];
  if (input.action === "reactivate" && topicId !== null) {
    events.push({
      type: "topic.status_changed",
      data: { topicId, status: "active", by: "user" },
    });
  }
  if (input.action === "done" && topicId !== null) {
    events.push({
      type: "topic.status_changed",
      data: { topicId, status: "done", by: "user" },
    });
  }
  events.push({
    type: "reminder.action",
    data: {
      reminderId: input.reminder.reminderId,
      topicId,
      action: input.action,
      until,
    },
  });
  const status = effectiveStatus(
    { status: statusForAction(input.action), until },
    nowMs,
  );
  return {
    events,
    reminder: {
      ...input.reminder,
      status,
      until,
    },
  };
}
