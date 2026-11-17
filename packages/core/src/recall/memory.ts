import { localDayKey } from "../consolidate/schedule.js";
import type { TopicBook } from "../topics/types.js";
import { resolveMergedTopic } from "../topics/zones.js";
import {
  RECALL_CONCLUSIONS,
  RECALL_HISTORY_CANDIDATES,
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
 * Whether a session is old enough to be recalled: not the triggering one and not
 * written within `RECALL_RECENT_MS`. The conversation itself, a second capture of it
 * from another tool, or something just discussed elsewhere is still the present.
 */
export function isRecallableSession(input: {
  sessionKey: string;
  currentSessionKey: string;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  nowMs: number;
}): boolean {
  if (input.sessionKey === input.currentSessionKey) return false;
  const updated = input.sessionUpdatedAt[input.sessionKey];
  if (updated === undefined) return true;
  const ms = Date.parse(updated);
  return Number.isNaN(ms) || input.nowMs - ms >= RECALL_RECENT_MS;
}

/**
 * The topic's old sessions to try for a raw history excerpt, newest first and capped:
 * the port materializes files, so a bounded candidate list keeps a failed read cheap.
 * Topics merged into this one count as this one.
 */
export function historyCandidates(input: {
  book: TopicBook;
  topicId: string;
  sessionKey: string;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  nowMs: number;
}): string[] {
  const topicId = resolveMergedTopic(input.book, input.topicId);
  const inTopic = (id: string | null): boolean =>
    id !== null && resolveMergedTopic(input.book, id) === topicId;
  const byUpdated = new Map(
    Object.entries(input.sessionUpdatedAt).map(([key, value]) => [key, value]),
  );
  const sessions = input.book.sessions
    .filter((session) => session.sessionKey !== input.sessionKey && inTopic(session.topicId))
    .filter((session) =>
      isRecallableSession({
        sessionKey: session.sessionKey,
        currentSessionKey: input.sessionKey,
        sessionUpdatedAt: input.sessionUpdatedAt,
        nowMs: input.nowMs,
      }),
    )
    .sort((left, right) => {
      const leftAt = byUpdated.get(left.sessionKey) ?? "";
      const rightAt = byUpdated.get(right.sessionKey) ?? "";
      if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
      return left.sessionKey < right.sessionKey ? 1 : -1;
    });
  return sessions.slice(0, RECALL_HISTORY_CANDIDATES).map((session) => session.sessionKey);
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
  const isOld = (key: string): boolean =>
    isRecallableSession({
      sessionKey: key,
      currentSessionKey: sessionKey,
      sessionUpdatedAt: input.sessionUpdatedAt,
      nowMs: input.nowMs,
    });
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
