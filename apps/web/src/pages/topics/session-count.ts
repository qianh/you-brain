/**
 * Session count for one topic row.
 * A list payload that includes `sessionCount` wins, including 0.
 * Older daemons omit the field: only the open topic can fall back to its loaded detail.
 */
export function listSessionCount(
  topic: { topicId: string },
  highlighted: string | null,
  detailCount: number | null,
): number | null {
  const own = readCount(topic);
  if (own !== null) return own;
  if (detailCount !== null && topic.topicId === highlighted) return detailCount;
  return null;
}

function readCount(topic: object): number | null {
  if (!Object.hasOwn(topic, "sessionCount")) return null;
  const value: unknown = Reflect.get(topic, "sessionCount");
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}
