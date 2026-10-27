import { z } from "zod";

import { NEXT_STEP_MAX, REASON_MAX, SUMMARY_MAX, collapseText, textUnits } from "./text.js";
import type { TwinEdit, VersionBump } from "./twin.js";

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

const ClaimsSchema = z.object({
  claims: z.array(
    z.object({
      layer: z.enum(["persona", "coding", "project"]),
      project: z.string(),
      confidence: z.enum(["high", "low"]),
      text: z.string(),
    }),
  ),
});

const EditsSchema = z.object({
  bump: z.enum(["patch", "minor", "major"]),
  changelog: z.array(z.string()),
  edits: z.array(
    z.object({
      layer: z.enum(["full", "coding", "projects"]),
      heading: z.string(),
      text: z.string(),
    }),
  ),
});

const ProbesSchema = z.object({
  probes: z.array(
    z.object({
      layer: z.enum(["persona", "coding"]),
      situation: z.string(),
      expect: z.string(),
    }),
  ),
});

const AnswersSchema = z.object({
  answers: z.array(z.object({ id: z.string(), answer: z.string() })),
});

const JudgeSchema = z.object({
  results: z.array(z.object({ id: z.string(), pass: z.boolean() })),
});

const MonthlySchema = z.object({
  notes: z.array(z.string().min(1)).max(12),
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

export interface TwinClaim {
  layer: "persona" | "coding" | "project";
  project: string;
  confidence: "high" | "low";
  text: string;
}

export interface TwinEditsUpdate {
  bump: VersionBump;
  changelog: string[];
  edits: TwinEdit[];
}

export interface TwinProbeDraft {
  layer: "persona" | "coding";
  situation: string;
  expect: string;
}

/** Blank claims drop; a project claim without a project name drops too. Same text keeps the first. */
export function parseTwinClaims(input: unknown): TwinClaim[] {
  const parsed = ClaimsSchema.parse(input);
  const seen = new Set<string>();
  const claims: TwinClaim[] = [];
  for (const claim of parsed.claims) {
    const text = collapseText(claim.text);
    const project = claim.layer === "project" ? collapseText(claim.project) : "";
    if (text === "" || (claim.layer === "project" && project === "")) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    claims.push({ layer: claim.layer, project, confidence: claim.confidence, text });
  }
  return claims;
}

/** Section text stays verbatim: structure and whitespace are part of the document. */
export function parseTwinEdits(input: unknown): TwinEditsUpdate {
  const parsed = EditsSchema.parse(input);
  const edits: TwinEdit[] = [];
  for (const edit of parsed.edits) {
    const heading = edit.heading.trim();
    if (heading === "") throw new Error("edits 里有空的 heading");
    edits.push({ layer: edit.layer, heading, text: edit.text });
  }
  return {
    bump: parsed.bump,
    changelog: parsed.changelog.map((line) => line.trim().replace(/\s+/gu, " ")).filter((line) => line !== ""),
    edits,
  };
}

export function parseTwinProbes(input: unknown): TwinProbeDraft[] {
  return ProbesSchema.parse(input)
    .probes.map((probe) => ({
      layer: probe.layer,
      situation: collapseText(probe.situation),
      expect: collapseText(probe.expect),
    }))
    .filter((probe) => probe.situation !== "" && probe.expect !== "");
}

export function parseTwinAnswers(input: unknown): Map<string, string> {
  const answers = new Map<string, string>();
  for (const item of AnswersSchema.parse(input).answers) answers.set(item.id.trim(), item.answer);
  return answers;
}

export function parseTwinJudge(input: unknown): Map<string, boolean> {
  const results = new Map<string, boolean>();
  for (const item of JudgeSchema.parse(input).results) results.set(item.id.trim(), item.pass);
  return results;
}

/** Trimmed, non-empty notes, at most six. */
export function parseTwinMonthly(input: unknown): string[] {
  const notes = MonthlySchema.parse(input).notes
    .map((note) => note.trim())
    .filter((note) => note !== "");
  return notes.slice(0, 6);
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
