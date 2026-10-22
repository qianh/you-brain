import type { Event, ReminderAction, TopicStatus } from "@you-brain/protocol";

import type { ReminderRecord } from "../../src/store/types.js";
import { buildEvent, sessionKey } from "../topics/helpers.js";

export const DAY = 24 * 60 * 60 * 1000;
export const KEY_A = sessionKey(41);
export const KEY_B = sessionKey(42);
export const KEY_C = sessionKey(43);

let seq = 1;

export function at(ms: number): string {
  return new Date(ms).toISOString();
}

export function topicEvents(input: {
  topicId: string;
  name: string;
  key: string;
  at: string;
  todos?: number;
  status?: TopicStatus;
  conclusions?: ReadonlyArray<{ id: string; text: string; ts: string }>;
}): Event[] {
  const events: Event[] = [
    buildEvent({
      type: "topic.created",
      data: { topicId: input.topicId, name: input.name, aliases: [] },
      device: "dev-a",
      ts: input.at,
      seq: seq++,
    }),
    buildEvent({
      type: "topic.assigned",
      data: { topicId: input.topicId, sessionKey: input.key },
      device: "dev-a",
      ts: input.at,
      seq: seq++,
    }),
  ];
  const count = input.todos ?? 1;
  for (let index = 0; index < count; index += 1) {
    events.push(
      buildEvent({
        type: "todo.added",
        data: {
          todoId: `${input.topicId}-todo-${index}`,
          topicId: input.topicId,
          text: `待办${index + 1}`,
          sessionKey: input.key,
          confidence: 0.8,
        },
        device: "dev-a",
        ts: input.at,
        seq: seq++,
      }),
    );
  }
  if (input.status !== undefined && input.status !== "active") {
    events.push(
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: input.topicId, status: input.status, by: "auto" },
        device: "dev-a",
        ts: input.at,
        seq: seq++,
      }),
    );
  }
  for (const conclusion of input.conclusions ?? []) {
    events.push(
      buildEvent({
        type: "conclusion.added",
        data: {
          conclusionId: conclusion.id,
          topicId: input.topicId,
          text: conclusion.text,
          sessionKey: input.key,
        },
        device: "dev-a",
        ts: conclusion.ts,
        seq: seq++,
      }),
    );
  }
  return events;
}

export function issuedEvents(
  items: ReadonlyArray<{
    reminderId: string;
    kind: string;
    topicId: string | null;
    text: string;
  }>,
  ts: string,
): Event[] {
  return items.map((item) =>
    buildEvent({
      type: "reminder.issued",
      data: item,
      device: "dev-main",
      ts,
      seq: seq++,
    }),
  );
}

export function actionEvent(input: {
  reminderId: string;
  topicId: string | null;
  action: ReminderAction;
  ts: string;
  until?: string | null;
}): Event {
  return buildEvent({
    type: "reminder.action",
    data: {
      reminderId: input.reminderId,
      topicId: input.topicId,
      action: input.action,
      until: input.until ?? null,
    },
    device: "dev-user",
    ts: input.ts,
    seq: seq++,
  });
}

export function reminderRecord(
  patch: Pick<ReminderRecord, "reminderId" | "kind" | "topicId" | "status"> &
    Partial<ReminderRecord>,
): ReminderRecord {
  return {
    text: patch.text ?? "提醒",
    until: patch.until ?? null,
    issuedAt: patch.issuedAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: patch.updatedAt ?? patch.issuedAt ?? "2026-01-01T00:00:00.000Z",
    reminderId: patch.reminderId,
    kind: patch.kind,
    topicId: patch.topicId,
    status: patch.status,
  };
}
