export interface GroupableSession {
  sessionKey: string;
  topicId: string | null;
  topicName: string | null;
  updatedAt: string | null;
  title: string;
}

export interface SessionGroup<T extends GroupableSession> {
  topicId: string | null;
  topicName: string;
  sessions: T[];
}

export function sessionStamp(value: string | null): number {
  if (value === null || value === "") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function compareSessionsDesc<T extends { updatedAt: string | null; sessionKey: string }>(
  left: T,
  right: T,
): number {
  const delta = sessionStamp(right.updatedAt) - sessionStamp(left.updatedAt);
  if (delta !== 0) return delta;
  if (left.sessionKey < right.sessionKey) return -1;
  if (left.sessionKey > right.sessionKey) return 1;
  return 0;
}

export function sortSessionsByTime<T extends { updatedAt: string | null; sessionKey: string }>(
  sessions: readonly T[],
): T[] {
  return [...sessions].sort(compareSessionsDesc);
}

export function groupSessionsByTopic<T extends GroupableSession>(
  sessions: readonly T[],
  unassignedName: string,
): SessionGroup<T>[] {
  const groups = new Map<string, SessionGroup<T>>();
  for (const session of sessions) {
    const key = session.topicId ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(session);
      if (session.topicId !== null && existing.topicName === unassignedName && session.topicName) {
        existing.topicName = session.topicName;
      }
      continue;
    }
    const topicName =
      session.topicId === null ? unassignedName : (session.topicName ?? unassignedName);
    groups.set(key, {
      topicId: session.topicId,
      topicName,
      sessions: [session],
    });
  }
  const list = [...groups.values()];
  for (const group of list) group.sessions.sort(compareSessionsDesc);
  list.sort((left, right) => {
    const delta =
      sessionStamp(right.sessions[0]?.updatedAt ?? null) -
      sessionStamp(left.sessions[0]?.updatedAt ?? null);
    if (delta !== 0) return delta;
    return left.topicName.localeCompare(right.topicName, "zh");
  });
  return list;
}

export interface TopicFilterFields {
  name: string;
  summary: string;
  nextStep: string;
  aliases: readonly string[];
}

export function filterTopics<T extends TopicFilterFields>(topics: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...topics];
  return topics.filter((topic) => {
    const haystack = [topic.name, topic.summary, topic.nextStep, ...topic.aliases]
      .join("\n")
      .toLocaleLowerCase();
    return haystack.includes(needle);
  });
}
