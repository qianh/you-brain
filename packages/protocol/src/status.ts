import { z } from "zod";

export const TOPIC_STATUSES = ["active", "follow_up", "done", "parked"] as const;

export const TopicStatusSchema = z.enum(TOPIC_STATUSES);

export type TopicStatus = z.infer<typeof TopicStatusSchema>;

export const TOPIC_STATUS_LABELS = {
  active: "进行中",
  follow_up: "待跟进",
  done: "已完结",
  parked: "搁置",
} as const satisfies Record<TopicStatus, string>;

export const TODO_STATUSES = ["open", "done", "dropped"] as const;

export const TodoStatusSchema = z.enum(TODO_STATUSES);

export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const EVENT_ACTORS = ["auto", "user"] as const;

export const EventActorSchema = z.enum(EVENT_ACTORS);

export type EventActor = z.infer<typeof EventActorSchema>;

export const REMINDER_ACTIONS = [
  "reactivate",
  "done",
  "snooze",
  "mute",
  "ignore",
] as const;

export const ReminderActionSchema = z.enum(REMINDER_ACTIONS);

export type ReminderAction = z.infer<typeof ReminderActionSchema>;
