import { compareText } from "../topics/order.js";
import type { TopicBook } from "../topics/types.js";
import { localDateKey, localParts } from "./time.js";

export const MAX_DIGEST_CONCLUSIONS = 60;

interface DigestDay {
  book: TopicBook;
  day: string;
  offsetMinutes: number;
  sourceSessionUpdatedAt: Readonly<Record<string, string>>;
  asOf: number;
}

export function occurrenceTime(
  item: { occurredAt?: string; sessionKey: string; ts: string },
  sourceSessionUpdatedAt: Readonly<Record<string, string>>,
  offsetMinutes: number,
): number {
  if (item.occurredAt !== undefined) return Date.parse(item.occurredAt);
  const activityMs = Date.parse(sourceSessionUpdatedAt[item.sessionKey] ?? "");
  const eventMs = Date.parse(item.ts);
  if (!Number.isFinite(activityMs) || !Number.isFinite(eventMs)) return Number.NaN;
  const eventDay = localDateKey(localParts(eventMs, offsetMinutes));
  const activityDay = localDateKey(localParts(activityMs, offsetMinutes));
  return activityMs <= eventMs || activityDay === eventDay ? activityMs : Number.NaN;
}

function sourceTime(
  item: { occurredAt?: string; sessionKey: string; ts: string },
  input: DigestDay,
): number {
  return occurrenceTime(item, input.sourceSessionUpdatedAt, input.offsetMinutes);
}

function onDay(ms: number, input: DigestDay): boolean {
  return Number.isFinite(ms) && localDateKey(localParts(ms, input.offsetMinutes)) === input.day;
}

export function digestConclusions(input: DigestDay) {
  return input.book.conclusions
    .flatMap((item) => {
      const ms = sourceTime(item, input);
      return Date.parse(item.ts) <= input.asOf && onDay(ms, input) ? [{ item, ms }] : [];
    })
    .sort((left, right) => right.ms - left.ms || compareText(left.item.conclusionId, right.item.conclusionId))
    .map(({ item }) => item);
}

export function hasUndatedDigestItems(input: DigestDay): boolean {
  const unknown = (item: { occurredAt?: string; sessionKey: string; ts: string }) => {
    const emitted = Date.parse(item.ts);
    return Number.isFinite(emitted) && emitted <= input.asOf &&
      localDateKey(localParts(emitted, input.offsetMinutes)) >= input.day &&
      !Number.isFinite(sourceTime(item, input));
  };
  return input.book.conclusions.some(unknown) || input.book.todos.some((todo) => todo.status === "open" && unknown(todo));
}

export function digestTodos(input: DigestDay) {
  return input.book.todos
    .flatMap((todo) => {
      if (todo.status !== "open" || !(Date.parse(todo.ts) <= input.asOf)) return [];
      const ms = sourceTime(todo, input);
      return onDay(ms, input) ? [{ todo, ms }] : [];
    })
    .sort((left, right) => right.ms - left.ms || compareText(left.todo.todoId, right.todo.todoId));
}

export function digestFollowUps(input: DigestDay, limit: number) {
  const todos = digestTodos(input);
  const latestByTopic = new Map<string, number>();
  for (const { todo, ms } of todos) {
    latestByTopic.set(todo.topicId, Math.max(ms, latestByTopic.get(todo.topicId) ?? ms));
  }
  const topics = new Map(input.book.topics.map((topic) => [topic.topicId, topic.name]));
  const suggestions = [...latestByTopic]
    .flatMap(([topicId, ms]) => {
      const name = topics.get(topicId);
      return name === undefined ? [] : [{ topicId, name, ms }];
    })
    .sort((left, right) => right.ms - left.ms || compareText(left.topicId, right.topicId))
    .slice(0, limit);
  return { todoIds: todos.map(({ todo }) => todo.todoId), suggestions };
}
