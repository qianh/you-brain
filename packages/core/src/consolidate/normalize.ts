import { z } from "zod";

import { NEXT_STEP_MAX, REASON_MAX, SUMMARY_MAX, collapseText, textUnits } from "./text.js";

const RewriteSchema = z.object({
  summary: z.string(),
  nextStep: z.string(),
});

const PairSchema = z.object({
  fromTopicId: z.string(),
  intoTopicId: z.string(),
  reason: z.string(),
});

const MergeSchema = z.object({
  pairs: z.array(PairSchema),
});

const PortraitUpdateSchema = z.object({
  changed: z.boolean(),
  portrait: z.string(),
});

export interface TopicRewrite {
  summary: string;
  nextStep: string;
}

export interface MergePair {
  fromTopicId: string;
  intoTopicId: string;
  reason: string;
}

export interface PortraitUpdate {
  changed: boolean;
  portrait: string;
}

/** Keep the portrait text verbatim. Structure and whitespace are part of the document. */
export function parsePortraitUpdate(input: unknown): PortraitUpdate {
  const parsed = PortraitUpdateSchema.parse(input);
  return { changed: parsed.changed, portrait: parsed.portrait };
}

export function parseTopicRewrite(input: unknown): TopicRewrite {
  const parsed = RewriteSchema.parse(input);
  const summary = collapseText(parsed.summary);
  const nextStep = collapseText(parsed.nextStep);
  if (summary === "") throw new Error("概要为空");
  if (textUnits(summary) > SUMMARY_MAX) throw new Error("概要超过 200 字");
  if (textUnits(nextStep) > NEXT_STEP_MAX) throw new Error("下一步超过 80 字");
  return { summary, nextStep };
}

/** Drop illegal pairs and keep at most 5. An unusable list becomes empty. */
export function normalizeMergePairs(
  input: unknown,
  allowedIds: ReadonlySet<string>,
): MergePair[] {
  const parsed = MergeSchema.parse(input);
  const seen = new Set<string>();
  const pairs: MergePair[] = [];
  for (const pair of parsed.pairs) {
    const fromTopicId = pair.fromTopicId.trim();
    const intoTopicId = pair.intoTopicId.trim();
    const reason = collapseText(pair.reason);
    if (!allowedIds.has(fromTopicId) || !allowedIds.has(intoTopicId)) continue;
    if (fromTopicId === intoTopicId) continue;
    if (reason === "" || textUnits(reason) > REASON_MAX) continue;
    const forward = `${fromTopicId}\0${intoTopicId}`;
    const reverse = `${intoTopicId}\0${fromTopicId}`;
    if (seen.has(forward) || seen.has(reverse)) continue;
    seen.add(forward);
    pairs.push({ fromTopicId, intoTopicId, reason });
    if (pairs.length >= 5) break;
  }
  return pairs;
}
