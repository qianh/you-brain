import type { ReminderView } from "../http/types.js";
import type { ReminderRecord } from "../store/types.js";

export interface ReminderTopicName {
  topicId: string;
  name: string;
  mergedInto: string | null;
}

export function effectiveStatus(record: Pick<ReminderRecord, "status" | "until">, nowMs: number): string {
  if (record.status !== "snoozed") return record.status;
  if (record.until === null) return "open";
  const until = Date.parse(record.until);
  if (Number.isNaN(until) || until <= nowMs) return "open";
  return "snoozed";
}

/** No longer issued; kept so an existing event log does not surface as open reminders. */
const LEGACY_HISTORY_KIND = "history";

export function presentReminders(
  records: readonly ReminderRecord[],
  now: string,
  topics: readonly ReminderTopicName[],
  all: boolean,
): ReminderView[] {
  const nowMs = Date.parse(now);
  const views = records
    // `history` reminders were issued one per archived topic before the weekly review
    // started naming a shortlist instead. The events stay in the log, so filter them here
    // rather than rewriting history on every device.
    .filter((record) => record.kind !== LEGACY_HISTORY_KIND)
    .map((record) => toView(record, nowMs, topics));
  const visible = all ? views : views.filter((item) => item.status === "open");
  visible.sort((left, right) => {
    if (left.issuedAt !== right.issuedAt) return left.issuedAt < right.issuedAt ? 1 : -1;
    return left.reminderId < right.reminderId ? -1 : left.reminderId > right.reminderId ? 1 : 0;
  });
  return visible;
}

export function presentReminder(
  record: ReminderRecord,
  now: string,
  topics: readonly ReminderTopicName[],
): ReminderView {
  const nowMs = Date.parse(now);
  return toView(record, Number.isNaN(nowMs) ? 0 : nowMs, topics);
}

function toView(record: ReminderRecord, nowMs: number, topics: readonly ReminderTopicName[]): ReminderView {
  return {
    reminderId: record.reminderId,
    kind: record.kind,
    topicId: record.topicId,
    topicName: lookupTopicName(topics, record.topicId),
    text: record.text,
    status: effectiveStatus(record, nowMs),
    until: record.until,
    issuedAt: record.issuedAt,
  };
}

function lookupTopicName(topics: readonly ReminderTopicName[], topicId: string | null): string | null {
  if (topicId === null) return null;
  const byId = new Map(topics.map((topic) => [topic.topicId, topic]));
  let current = topicId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const topic = byId.get(current);
    if (!topic) return null;
    if (!topic.mergedInto) return topic.name;
    current = topic.mergedInto;
  }
  return null;
}
