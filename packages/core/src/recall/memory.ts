import { localDayKey } from "../consolidate/schedule.js";
import type { TopicBook } from "../topics/types.js";
import { resolveMergedTopic } from "../topics/zones.js";
import {
  RECALL_CONCLUSIONS,
  RECALL_RECENT_MS,
  RECALL_TODOS,
  type RecallMemory,
  type RecallMemoryItem,
} from "./types.js";

function dayOf(ts: string, timeZone: string): string | null {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : localDayKey(new Date(ms), timeZone);
}

function newestFirst<T extends { ts: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => (left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0));
}

/**
 * What the topic remembers, minus anything still current: the session itself and every
 * session written within `RECALL_RECENT_MS`. A reminder must never hand the user back
 * what they just said, and the same conversation is sometimes captured twice (a host app
 * and the CLI under it), so excluding only the triggering session is not enough.
 * Topics merged into this one count as this one. Null when there is nothing to recall.
 */
export function buildRecallMemory(input: {
  book: TopicBook;
  topicId: string;
  sessionKey: string;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  timeZone: string;
  nowMs: number;
}): RecallMemory | null {
  const { book, sessionKey, timeZone } = input;
  const isOld = (key: string): boolean => {
    if (key === sessionKey) return false;
    const updated = input.sessionUpdatedAt[key];
    if (updated === undefined) return true;
    const ms = Date.parse(updated);
    return Number.isNaN(ms) || input.nowMs - ms >= RECALL_RECENT_MS;
  };
  const topicId = resolveMergedTopic(book, input.topicId);
  const topic = book.topics.find((item) => item.topicId === topicId);
  if (!topic) return null;
  const inTopic = (id: string): boolean => resolveMergedTopic(book, id) === topicId;

  const items: RecallMemoryItem[] = [];
  if (topic.nextStep.trim() !== "") {
    items.push({ id: "next", kind: "next_step", text: topic.nextStep, day: null, sessionKey: null });
  }
  const todos = newestFirst(
    book.todos.filter(
      (todo) => todo.status === "open" && isOld(todo.sessionKey) && inTopic(todo.topicId),
    ),
  ).slice(0, RECALL_TODOS);
  for (const todo of todos) {
    items.push({
      id: `todo:${todo.todoId}`,
      kind: "todo",
      text: todo.text,
      day: dayOf(todo.ts, timeZone),
      sessionKey: todo.sessionKey,
    });
  }
  const conclusions = newestFirst(
    book.conclusions.filter((item) => isOld(item.sessionKey) && inTopic(item.topicId)),
  ).slice(0, RECALL_CONCLUSIONS);
  for (const conclusion of conclusions) {
    items.push({
      id: `conclusion:${conclusion.conclusionId}`,
      kind: "conclusion",
      text: conclusion.text,
      day: dayOf(conclusion.ts, timeZone),
      sessionKey: conclusion.sessionKey,
    });
  }
  if (items.length === 0) return null;

  let last: string | null = null;
  for (const session of book.sessions) {
    if (!isOld(session.sessionKey) || session.topicId === null || !inTopic(session.topicId)) continue;
    const updated = input.sessionUpdatedAt[session.sessionKey];
    if (updated !== undefined && (last === null || updated > last)) last = updated;
  }
  return {
    topicId,
    name: topic.name,
    summary: topic.summary,
    lastActiveDay: last === null ? null : dayOf(last, timeZone),
    items,
  };
}
