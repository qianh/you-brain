/** Attach how many sessions belong to each topic. Missing or blank topic ids are not counted. */
export function withSessionCounts<T extends { topicId: string }>(
  topics: readonly T[],
  sessions: readonly { topicId: string | null }[],
): Array<T & { sessionCount: number }> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const id = session.topicId;
    if (id === null || id.length === 0) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return topics.map((topic) => ({ ...topic, sessionCount: counts.get(topic.topicId) ?? 0 }));
}
