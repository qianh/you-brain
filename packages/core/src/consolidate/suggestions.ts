import { z } from "zod";

import type { MergePair } from "./normalize.js";

export const MERGE_SUGGESTIONS_CURSOR = "consolidate.merge_suggestions";

const StoredSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  pairs: z.array(
    z.object({
      fromTopicId: z.string().min(1),
      intoTopicId: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
});

export interface MergeSuggestions {
  day: string;
  pairs: MergePair[];
}

export interface MergeSuggestionLine {
  fromName: string;
  intoName: string;
  reason: string;
}

export function parseMergeSuggestions(raw: string | null): MergeSuggestions | null {
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function mergeSuggestionLines(
  stored: MergeSuggestions | null,
  topics: readonly { topicId: string; name: string }[],
): MergeSuggestionLine[] {
  if (!stored) return [];
  const names = new Map(topics.map((topic) => [topic.topicId, topic.name]));
  const lines: MergeSuggestionLine[] = [];
  for (const pair of stored.pairs) {
    const fromName = names.get(pair.fromTopicId)?.trim();
    const intoName = names.get(pair.intoTopicId)?.trim();
    if (!fromName || !intoName) continue;
    lines.push({ fromName, intoName, reason: pair.reason });
  }
  return lines;
}
