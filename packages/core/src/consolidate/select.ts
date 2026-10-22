import type { Event } from "@you-brain/protocol";

import { partitionTopics, resolveMergedTopic } from "../topics/zones.js";
import type { SessionState, TopicBook, ZonedTopic } from "../topics/types.js";
import { instantOnLocalDay } from "./schedule.js";

export const RECENT_SESSIONS = 12;
export const MERGE_TOPIC_LIMIT = 40;

export interface ChangedTopic {
  topic: ZonedTopic;
  lastChangeMs: number;
}

export function selectChangedTopics(input: {
  book: TopicBook;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  day: string;
  timeZone: string;
  now: string;
  activeLimit: number;
  historyDays: number;
}): ChangedTopic[] {
  const zoned = partitionTopics(input.book, {
    now: input.now,
    activeLimit: input.activeLimit,
    historyDays: input.historyDays,
    sessionUpdatedAt: input.sessionUpdatedAt,
  });
  const visible = [...zoned.active, ...zoned.history];
  const changed: ChangedTopic[] = [];
  for (const topic of visible) {
    if (topic.userLocked || topic.mergedInto !== null) continue;
    const lastChangeMs = lastChangeOnDay(input.book, topic.topicId, input);
    if (lastChangeMs === null) continue;
    const rewritten = latestRewriteMs(input.book, topic.topicId);
    if (rewritten !== null && rewritten > lastChangeMs) continue;
    changed.push({ topic, lastChangeMs });
  }
  changed.sort((left, right) => {
    if (left.lastChangeMs !== right.lastChangeMs) return right.lastChangeMs - left.lastChangeMs;
    return left.topic.topicId < right.topic.topicId ? -1 : 1;
  });
  return changed;
}

export function recentTopicSessions(input: {
  book: TopicBook;
  topicId: string;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  day: string;
  timeZone: string;
}): SessionState[] {
  const sessions = input.book.sessions.filter((session) => session.topicId === input.topicId);
  const ranked = sessions.map((session) => ({
    session,
    ...sessionRank(input.book, session, input),
  }));
  ranked.sort((left, right) => {
    if (left.onDay !== right.onDay) return left.onDay ? -1 : 1;
    if (left.ms !== right.ms) return right.ms - left.ms;
    return left.session.sessionKey < right.session.sessionKey ? -1 : 1;
  });
  return ranked.slice(0, RECENT_SESSIONS).map((item) => item.session);
}

export function selectMergeCandidates(
  topics: readonly ZonedTopic[],
  limit = MERGE_TOPIC_LIMIT,
): ZonedTopic[] {
  return [...topics]
    .sort((left, right) => {
      const leftMs = stamp(left.lastActive);
      const rightMs = stamp(right.lastActive);
      if (leftMs !== rightMs) return rightMs - leftMs;
      return left.topicId < right.topicId ? -1 : 1;
    })
    .slice(0, Math.max(0, limit));
}

function lastChangeOnDay(
  book: TopicBook,
  topicId: string,
  input: {
    sessionUpdatedAt: Readonly<Record<string, string>>;
    day: string;
    timeZone: string;
  },
): number | null {
  const stamps: number[] = [];
  const consider = (iso: string | null | undefined): void => {
    if (!iso || !instantOnLocalDay(iso, input.day, input.timeZone)) return;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) stamps.push(ms);
  };
  for (const session of book.sessions) {
    if (session.topicId !== topicId) continue;
    consider(input.sessionUpdatedAt[session.sessionKey]);
  }
  for (const event of book.memory.log) considerEvent(book, topicId, event, consider);
  if (stamps.length === 0) return null;
  return Math.max(...stamps);
}

function considerEvent(
  book: TopicBook,
  topicId: string,
  event: Event,
  consider: (iso: string) => void,
): void {
  switch (event.type) {
    case "topic.assigned":
      if (resolveMergedTopic(book, event.data.topicId) === topicId) consider(event.ts);
      return;
    case "session.refined": {
      const session = book.sessions.find((item) => item.sessionKey === event.data.sessionKey);
      if (session?.topicId === topicId) consider(event.ts);
      return;
    }
    case "conclusion.added":
    case "todo.added":
      if (resolveMergedTopic(book, event.data.topicId) === topicId) consider(event.ts);
      return;
    default:
      return;
  }
}

function latestRewriteMs(book: TopicBook, topicId: string): number | null {
  let best: number | null = null;
  for (const event of book.memory.log) {
    if (event.type !== "topic.summary_rewritten") continue;
    if (resolveMergedTopic(book, event.data.topicId) !== topicId) continue;
    const ms = Date.parse(event.ts);
    if (Number.isNaN(ms)) continue;
    if (best === null || ms > best) best = ms;
  }
  return best;
}

function sessionRank(
  book: TopicBook,
  session: SessionState,
  input: {
    sessionUpdatedAt: Readonly<Record<string, string>>;
    day: string;
    timeZone: string;
  },
): { onDay: boolean; ms: number } {
  let onDay = false;
  let ms = Number.NEGATIVE_INFINITY;
  const consider = (iso: string | null | undefined, counts: boolean): void => {
    if (!iso) return;
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) return;
    const sameDay = instantOnLocalDay(iso, input.day, input.timeZone);
    if (counts && sameDay) onDay = true;
    if (parsed > ms) ms = parsed;
  };
  consider(input.sessionUpdatedAt[session.sessionKey], true);
  for (const event of book.memory.log) {
    if (event.type === "session.refined" && event.data.sessionKey === session.sessionKey) {
      consider(event.ts, true);
    }
    if (
      (event.type === "conclusion.added" || event.type === "todo.added") &&
      event.data.sessionKey === session.sessionKey
    ) {
      consider(event.ts, true);
    }
    if (event.type === "topic.assigned" && event.data.sessionKey === session.sessionKey) {
      consider(event.ts, true);
    }
  }
  return { onDay, ms };
}

function stamp(iso: string | null): number {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}
