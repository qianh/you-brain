import { createMergedTopicResolver, partitionTopics } from "../topics/zones.js";
import type { SessionState, TopicBook, ZonedTopic } from "../topics/types.js";
import { createLocalDayMatcher } from "./schedule.js";

export const RECENT_SESSIONS = 12;
export const MERGE_TOPIC_LIMIT = 40;

export interface ChangedTopic {
  topic: ZonedTopic;
  lastChangeMs: number;
}

interface DaySelectionInput {
  book: TopicBook;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  day: string;
  timeZone: string;
  now: string;
  activeLimit: number;
  historyDays: number;
}

interface DayActivityIndex {
  lastChangeByTopic: Map<string, number>;
  latestRewriteByTopic: Map<string, number>;
}

export function selectChangedTopics(input: DaySelectionInput): ChangedTopic[] {
  const index = indexDayActivity(input.book, input, true);
  return buildChangedTopics(input, index.lastChangeByTopic).filter((item) => {
    const rewritten = index.latestRewriteByTopic.get(item.topic.topicId);
    return rewritten === undefined || rewritten <= item.lastChangeMs;
  });
}

/** Topics touched on `day`, including ones whose summary was already rewritten. */
export function selectTopicsChangedOnDay(input: DaySelectionInput): ChangedTopic[] {
  const index = indexDayActivity(input.book, input, false);
  return buildChangedTopics(input, index.lastChangeByTopic);
}

function buildChangedTopics(
  input: DaySelectionInput,
  lastChangeByTopic: ReadonlyMap<string, number>,
): ChangedTopic[] {
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
    const lastChangeMs = lastChangeByTopic.get(topic.topicId);
    if (lastChangeMs === undefined) continue;
    changed.push({ topic, lastChangeMs });
  }
  changed.sort((left, right) => {
    if (left.lastChangeMs !== right.lastChangeMs) return right.lastChangeMs - left.lastChangeMs;
    return left.topic.topicId < right.topic.topicId ? -1 : 1;
  });
  return changed;
}

function indexDayActivity(
  book: TopicBook,
  input: {
    sessionUpdatedAt: Readonly<Record<string, string>>;
    day: string;
    timeZone: string;
  },
  trackRewrites: boolean,
): DayActivityIndex {
  const lastChangeByTopic = new Map<string, number>();
  const latestRewriteByTopic = new Map<string, number>();
  const resolve = createMergedTopicResolver(book);
  const matchDay = createLocalDayMatcher(input.day, input.timeZone);
  const sessionByKey = new Map<string, SessionState>();

  const recordMax = (map: Map<string, number>, topicId: string, ms: number): void => {
    const prev = map.get(topicId);
    if (prev === undefined || ms > prev) map.set(topicId, ms);
  };

  for (const session of book.sessions) {
    sessionByKey.set(session.sessionKey, session);
    if (session.topicId === null) continue;
    const ms = matchDay(input.sessionUpdatedAt[session.sessionKey]);
    if (ms !== null) recordMax(lastChangeByTopic, session.topicId, ms);
  }

  for (const event of book.memory.log) {
    switch (event.type) {
      case "topic.assigned":
      case "conclusion.added":
      case "todo.added": {
        const ms = matchDay(event.ts);
        if (ms !== null) recordMax(lastChangeByTopic, resolve(event.data.topicId), ms);
        break;
      }
      case "session.refined": {
        const ms = matchDay(event.ts);
        if (ms !== null) {
          const topicId = sessionByKey.get(event.data.sessionKey)?.topicId;
          if (topicId !== null && topicId !== undefined) {
            recordMax(lastChangeByTopic, topicId, ms);
          }
        }
        break;
      }
      case "topic.summary_rewritten": {
        if (!trackRewrites) break;
        const ms = Date.parse(event.ts);
        if (!Number.isNaN(ms)) recordMax(latestRewriteByTopic, resolve(event.data.topicId), ms);
        break;
      }
      default:
        break;
    }
  }

  return { lastChangeByTopic, latestRewriteByTopic };
}

export function recentTopicSessions(input: {
  book: TopicBook;
  topicId: string;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  day: string;
  timeZone: string;
}): SessionState[] {
  const sessions = input.book.sessions.filter((session) => session.topicId === input.topicId);
  if (sessions.length === 0) return [];

  const matchDay = createLocalDayMatcher(input.day, input.timeZone);
  const rankByKey = new Map<string, { onDay: boolean; ms: number }>();

  const consider = (
    rank: { onDay: boolean; ms: number },
    iso: string | null | undefined,
  ): void => {
    if (!iso) return;
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) return;
    if (!rank.onDay && matchDay(iso) !== null) rank.onDay = true;
    if (parsed > rank.ms) rank.ms = parsed;
  };

  for (const session of sessions) {
    const rank = { onDay: false, ms: Number.NEGATIVE_INFINITY };
    consider(rank, input.sessionUpdatedAt[session.sessionKey]);
    rankByKey.set(session.sessionKey, rank);
  }

  for (const event of input.book.memory.log) {
    if (
      event.type !== "session.refined" &&
      event.type !== "conclusion.added" &&
      event.type !== "todo.added" &&
      event.type !== "topic.assigned"
    ) {
      continue;
    }
    const rank = rankByKey.get(event.data.sessionKey);
    if (rank) consider(rank, event.ts);
  }

  const ranked = sessions.map((session) => ({
    session,
    ...(rankByKey.get(session.sessionKey) ?? { onDay: false, ms: Number.NEGATIVE_INFINITY }),
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

function stamp(iso: string | null): number {
  if (iso === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}
