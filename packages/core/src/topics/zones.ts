import { YouBrainError } from "../domain/errors.js";
import { compareText } from "./order.js";
import type { TopicBook, TopicState, ZonePartition, ZoneQuery, ZonedTopic } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Stamp {
  ms: number;
  text: string;
}

function prefer(current: Stamp | null, text: string): Stamp | null {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return current;
  if (!current || ms > current.ms || (ms === current.ms && text > current.text)) {
    return { ms, text };
  }
  return current;
}

export function deriveLastActive(
  book: TopicBook,
  sessionUpdatedAt?: Readonly<Record<string, string>>,
): Map<string, string | null> {
  const activity = sessionUpdatedAt ?? {};
  const byTopic = new Map<string, Stamp>();
  const sessions = [...book.sessions].sort((left, right) =>
    compareText(left.sessionKey, right.sessionKey),
  );
  for (const session of sessions) {
    if (session.topicId === null) continue;
    const text = activity[session.sessionKey];
    if (text === undefined) continue;
    const next = prefer(byTopic.get(session.topicId) ?? null, text);
    if (next) byTopic.set(session.topicId, next);
  }
  const result = new Map<string, string | null>();
  for (const topic of book.topics) {
    let best = byTopic.get(topic.topicId) ?? null;
    if (topic.lastUserOpAt) best = prefer(best, topic.lastUserOpAt);
    result.set(topic.topicId, best?.text ?? null);
  }
  return result;
}

function decorate(
  topic: TopicState,
  lastActive: string | null,
  zone: ZonedTopic["zone"],
): ZonedTopic {
  return { ...topic, aliases: [...topic.aliases], lastActive, zone };
}

function lastMs(text: string | null): number | null {
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

export function partitionTopics(book: TopicBook, query: ZoneQuery): ZonePartition {
  const nowMs = Date.parse(query.now);
  if (Number.isNaN(nowMs)) {
    throw new YouBrainError("INVALID_INPUT", "now must be an ISO-8601 timestamp");
  }
  const limit = Number.isFinite(query.activeLimit)
    ? Math.max(0, Math.floor(query.activeLimit))
    : 0;
  const windowMs = query.historyDays * DAY_MS;
  const lastActive = deriveLastActive(book, query.sessionUpdatedAt);
  const visible = book.topics.filter((topic) => topic.mergedInto === null);
  const candidates = visible
    .flatMap((topic) => {
      if (topic.status === "done") return [];
      const text = lastActive.get(topic.topicId) ?? null;
      const ms = lastMs(text);
      if (ms === null || nowMs - ms >= windowMs) return [];
      return [{ topic, text, ms }];
    })
    .sort((left, right) => {
      if (left.ms !== right.ms) return right.ms - left.ms;
      return compareText(left.topic.topicId, right.topic.topicId);
    });
  const active = candidates
    .slice(0, limit)
    .map((candidate) => decorate(candidate.topic, candidate.text, "active"));
  const activeIds = new Set(active.map((topic) => topic.topicId));
  const history = visible
    .filter((topic) => !activeIds.has(topic.topicId))
    .map((topic) => decorate(topic, lastActive.get(topic.topicId) ?? null, "history"))
    .sort((left, right) => {
      const leftMs = lastMs(left.lastActive);
      const rightMs = lastMs(right.lastActive);
      if (leftMs === null && rightMs === null) return compareText(left.topicId, right.topicId);
      if (leftMs === null) return 1;
      if (rightMs === null) return -1;
      if (leftMs !== rightMs) return rightMs - leftMs;
      return compareText(left.topicId, right.topicId);
    });
  return { active, history };
}

export function resolveMergedTopic(book: TopicBook, topicId: string): string {
  const byId = new Map(book.topics.map((topic) => [topic.topicId, topic]));
  let current = topicId;
  const seen = new Set<string>();
  while (true) {
    const next = byId.get(current)?.mergedInto;
    if (!next || seen.has(current)) return current;
    seen.add(current);
    current = next;
  }
}
