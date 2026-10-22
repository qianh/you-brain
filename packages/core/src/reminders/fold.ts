import type { Event, ReminderAction } from "@you-brain/protocol";

import type { ReminderRecord } from "../store/types.js";
import { compareEvents } from "../topics/order.js";

export type ReminderStatus = "open" | "snoozed" | "done" | "dismissed" | "muted";

interface Draft {
  reminderId: string;
  kind: string;
  topicId: string | null;
  text: string;
  status: ReminderStatus;
  until: string | null;
  issuedAt: string;
  updatedAt: string;
  acted: boolean;
  seenIssued: boolean;
}

export function statusForAction(action: ReminderAction): ReminderStatus {
  switch (action) {
    case "snooze":
      return "snoozed";
    case "mute":
      return "muted";
    case "ignore":
      return "dismissed";
    case "done":
    case "reactivate":
      return "done";
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** Fold `reminder.issued` and `reminder.action` into reminder rows. Replay is deterministic. */
export function foldReminders(events: readonly Event[]): ReminderRecord[] {
  const ordered = uniqueSorted(events);
  const rows = new Map<string, Draft>();
  for (const event of ordered) {
    if (event.type === "reminder.issued") applyIssued(rows, event);
    else if (event.type === "reminder.action") applyAction(rows, event);
  }
  return [...rows.values()]
    .map(toRecord)
    .sort((left, right) => {
      if (left.issuedAt !== right.issuedAt) return left.issuedAt < right.issuedAt ? -1 : 1;
      return left.reminderId < right.reminderId ? -1 : left.reminderId > right.reminderId ? 1 : 0;
    });
}

function applyIssued(rows: Map<string, Draft>, event: Extract<Event, { type: "reminder.issued" }>): void {
  const row = ensure(rows, event.data.reminderId, event.ts);
  row.kind = event.data.kind;
  row.topicId = event.data.topicId;
  row.text = event.data.text;
  row.issuedAt = event.ts;
  row.updatedAt = event.ts;
  row.seenIssued = true;
  if (!row.acted) {
    row.status = "open";
    row.until = null;
  }
}

function applyAction(rows: Map<string, Draft>, event: Extract<Event, { type: "reminder.action" }>): void {
  const row = ensure(rows, event.data.reminderId, event.ts);
  if (!row.seenIssued) row.topicId = event.data.topicId;
  row.status = statusForAction(event.data.action);
  row.until = event.data.action === "snooze" ? event.data.until : null;
  row.updatedAt = event.ts;
  row.acted = true;
}

function ensure(rows: Map<string, Draft>, reminderId: string, ts: string): Draft {
  const existing = rows.get(reminderId);
  if (existing) return existing;
  const created: Draft = {
    reminderId,
    kind: "",
    topicId: null,
    text: "",
    status: "open",
    until: null,
    issuedAt: ts,
    updatedAt: ts,
    acted: false,
    seenIssued: false,
  };
  rows.set(reminderId, created);
  return created;
}

function toRecord(row: Draft): ReminderRecord {
  return {
    reminderId: row.reminderId,
    kind: row.kind,
    topicId: row.topicId,
    text: row.text,
    status: row.status,
    until: row.until,
    issuedAt: row.issuedAt,
    updatedAt: row.updatedAt,
  };
}

function uniqueSorted(events: readonly Event[]): Event[] {
  const sorted = [...events].sort(compareEvents);
  const seen = new Set<string>();
  const unique: Event[] = [];
  for (const event of sorted) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}
