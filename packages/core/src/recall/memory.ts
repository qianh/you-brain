import { localDayKey } from "../consolidate/schedule.js";
import type { TopicBook } from "../topics/types.js";
import { resolveMergedTopic } from "../topics/zones.js";
import {
  RECALL_CONCLUSIONS,
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
 * What the topic remembers, minus anything the current session itself produced:
 * a reminder must never hand the user back what they just said.
 * Topics merged into this one count as this one. Null when there is nothing to recall.
 */
export function buildRecallMemory(input: {
  book: TopicBook;
  topicId: string;
  sessionKey: string;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  timeZone: string;
}): RecallMemory | null {
  const { book, sessionKey, timeZone } = input;
  const topicId = resolveMergedTopic(book, input.topicId);
  const topic = book.topics.find((item) => item.topicId === topicId);
  if (!topic) return null;
  const inTopic = (id: string): boolean => resolveMergedTopic(book, id) === topicId;

  const items: RecallMemoryItem[] = [];
  if (topic.nextStep.trim() !== "") {
    items.push({ id: "next", kind: "next_step", text: topic.nextStep, day: null });
  }
  const todos = newestFirst(
    book.todos.filter(
      (todo) => todo.status === "open" && todo.sessionKey !== sessionKey && inTopic(todo.topicId),
    ),
  ).slice(0, RECALL_TODOS);
  for (const todo of todos) {
    items.push({ id: `todo:${todo.todoId}`, kind: "todo", text: todo.text, day: dayOf(todo.ts, timeZone) });
  }
  const conclusions = newestFirst(
    book.conclusions.filter((item) => item.sessionKey !== sessionKey && inTopic(item.topicId)),
  ).slice(0, RECALL_CONCLUSIONS);
  for (const conclusion of conclusions) {
    items.push({
      id: `conclusion:${conclusion.conclusionId}`,
      kind: "conclusion",
      text: conclusion.text,
      day: dayOf(conclusion.ts, timeZone),
    });
  }
  if (items.length === 0) return null;

  let last: string | null = null;
  for (const session of book.sessions) {
    if (session.sessionKey === sessionKey || session.topicId === null || !inTopic(session.topicId)) continue;
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
