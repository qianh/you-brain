import { isAutomatedBatchPrompt, isCliControlTurn, isInjectedPrompt } from "../adapters/conversation.js";
import { ConflictError } from "../drive/errors.js";
import { sha256Hex } from "../drive/hash.js";
import type { LlmBackend } from "../llm/types.js";
import { completeJsonWithRetry } from "./llm-json.js";
import {
  nextCodingProposalNumber,
  normalizeCodingRuleLine,
  seedCodingFromMarkdown,
  type CodingRuleProposal,
} from "./coding-proposals.js";
import {
  parseTwinAnswers,
  parseTwinClaims,
  parseTwinCodingProposals,
  parseTwinEdits,
  parseTwinJudge,
  parseTwinMonthly,
  parseTwinProbes,
  type TwinClaim,
  type TwinEditsUpdate,
} from "./normalize.js";
import {
  buildTwinClaimsPrompt,
  buildTwinCodingProposalsPrompt,
  buildTwinEvalAnswerPrompt,
  buildTwinEvalJudgePrompt,
  buildTwinFixPrompt,
  buildTwinMergePrompt,
  buildTwinMonthlyPrompt,
  buildTwinProbesPrompt,
  buildTwinProjectMergePrompt,
  TWIN_EVAL_GENERIC_PERSONA,
  type TwinPromptCorrection,
} from "./prompt.js";
import { shiftDateKey } from "./schedule.js";
import {
  TWIN_CLAIMS_JSON_SCHEMA,
  TWIN_CODING_PROPOSALS_JSON_SCHEMA,
  TWIN_EDITS_JSON_SCHEMA,
  TWIN_EVAL_ANSWERS_JSON_SCHEMA,
  TWIN_EVAL_JUDGE_JSON_SCHEMA,
  TWIN_MONTHLY_JSON_SCHEMA,
  TWIN_PROBES_JSON_SCHEMA,
} from "./schema.js";
import type {
  ConsolidationPortrait,
  ConsolidationStep,
  StoredTwinClaim,
  TwinFileRef,
  TwinProbe,
} from "./steps.js";
import { clipUnits, textUnits } from "./text.js";
import {
  TWIN_LAYERS,
  TWIN_SCAN,
  applyTwinEdits,
  bumpVersion,
  changedLayers,
  checkTwin,
  parseProjectGroups,
  projectPrefixOfHeading,
  skeletonTwin,
  splitTwin,
  twinBody,
  twinVersion,
  withHeader,
  withProjectsPointer,
  type TwinCheck,
  type TwinLayer,
  type TwinTexts,
  type VersionBump,
} from "./twin.js";
import { twinCrossLayerProblems, twinStandardProblems } from "./twin-standard.js";

const EXTRACT_CONCURRENCY = 3;
/** Units of user text per extraction call. */
const CHUNK_UNITS = 10_000;
/** Units of user text one day may send; the rest waits for the next run. */
const DAY_UNITS = 40_000;
const TURN_CLIP = 1_500;
/** Units of claims per rebuild merge. */
const REBUILD_BATCH_UNITS = 11_000;
const REBUILD_FIX_PASSES = 3;
const PENDING_KEEP_DAYS = 60;
const EVAL_INTERVAL_DAYS = 7;
/** New probes one weekly run may add. */
const WEEKLY_PROBES = 8;
/** Rounds of answering and judging per condition; one round flipped two or three of 16 probes. */
const EVAL_ROUNDS = 3;
/** Units of the week's user turns sent to the probe writer, and the most one session may take. */
const PROBE_INPUT_UNITS = 30_000;
const PROBE_SESSION_UNITS = 4_000;

export const PORTRAIT_TURNS_CURSOR = "portrait.turns";
export const PORTRAIT_EVAL_CURSOR = "portrait.eval";
export const PORTRAIT_STAGE_CURSOR = "portrait.stages";
const MAX_STAGE_CACHE_ENTRIES = 64;

interface PortraitStageCacheState {
  day: string;
  entries: Record<string, unknown>;
}

type StageCompleter = <T>(
  stage: string,
  llm: LlmBackend,
  prompt: { system: string; user: string },
  jsonSchema: Record<string, unknown>,
  parse: (input: unknown) => T,
  signal?: AbortSignal,
  cacheKeyInput?: string,
) => Promise<T>;

function parseStageCache(raw: string | null, day: string): PortraitStageCacheState {
  if (!raw || raw.trim() === "") return { day, entries: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { day, entries: {} };
    const record = parsed as { day?: unknown; entries?: unknown };
    if (record.day !== day) return { day, entries: {} };
    if (!record.entries || typeof record.entries !== "object" || Array.isArray(record.entries)) {
      return { day, entries: {} };
    }
    return { day, entries: { ...(record.entries as Record<string, unknown>) } };
  } catch {
    return { day, entries: {} };
  }
}

function createStageCompleter(
  cursors: { get(key: string): string | null; set(key: string, value: string): void },
  day: string,
): { complete: StageCompleter; clear: () => void } {
  const state = parseStageCache(cursors.get(PORTRAIT_STAGE_CURSOR), day);
  let hasStored = cursors.get(PORTRAIT_STAGE_CURSOR) !== null && cursors.get(PORTRAIT_STAGE_CURSOR) !== "";

  const complete: StageCompleter = async (
    stage,
    llm,
    prompt,
    jsonSchema,
    parse,
    signal,
    cacheKeyInput,
  ) => {
    const keyPayload =
      cacheKeyInput ??
      `${stage}\n${prompt.system}\n${prompt.user}\n${JSON.stringify(jsonSchema)}`;
    const key = sha256Hex(Buffer.from(keyPayload, "utf8"));
    if (Object.prototype.hasOwnProperty.call(state.entries, key)) {
      return state.entries[key] as ReturnType<typeof parse>;
    }
    const result = await completeJson(llm, prompt, jsonSchema, parse, signal);
    state.entries[key] = result;
    const keys = Object.keys(state.entries);
    while (keys.length > MAX_STAGE_CACHE_ENTRIES) {
      const oldest = keys.shift();
      if (oldest !== undefined) delete state.entries[oldest];
    }
    cursors.set(PORTRAIT_STAGE_CURSOR, JSON.stringify(state));
    hasStored = true;
    return result;
  };

  const clear = (): void => {
    if (!hasStored) return;
    hasStored = false;
    state.entries = {};
    cursors.set(PORTRAIT_STAGE_CURSOR, "");
  };

  return { complete, clear };
}

export const portraitStep: ConsolidationStep = {
  id: "portrait",
  async run(ctx) {
    const portrait = ctx.portrait;
    if (!portrait) return;
    const stageCache = createStageCompleter(ctx.cursors, ctx.day);
    const files = await portrait.read();
    if (!files.full || !files.coding) {
      ctx.warnings.push("没有现有数字分身，跳过");
      stageCache.clear();
      return;
    }
    const before = textsOf(files);
    const seen = parseTurnCursor(ctx.cursors.get(PORTRAIT_TURNS_CURSOR));
    const input = collectTurns(await portrait.sessions(ctx.day, { budgetUnits: DAY_UNITS }), seen);
    const corrections = portrait.corrections();
    const keepFrom = shiftDateKey(ctx.day, -PENDING_KEEP_DAYS);
    const earlier = (await portrait.pendingClaims()).filter((claim) => claim.day !== ctx.day);
    const earlierHigh = earlier.filter(
      (claim) => claim.confidence === "high" && claim.day >= keepFrom && !hasSensitiveHit(claim.text),
    );
    const earlierLow = earlier.filter(
      (claim) => claim.confidence === "low" && claim.day >= keepFrom && !hasSensitiveHit(claim.text),
    );
    if (input.chunks.length === 0 && corrections.length === 0 && earlierHigh.length === 0) {
      stageCache.clear();
      return;
    }

    const claims =
      input.chunks.length > 0
        ? (
            await extractClaims(
              ctx.llm,
              input.chunks,
              "sessions",
              projectNames(before.projects),
              undefined,
              ctx.signal,
              stageCache.complete,
            )
          ).map((claim) => ({
            ...claim,
            day: ctx.day,
          }))
        : [];
    const low = claims.filter((claim) => claim.confidence === "low" && !hasSensitiveHit(claim.text));

    // 1. Session coding claims become reviewable proposals instead of mutating coding.md directly.
    const codingClaims = claims.filter((claim) => claim.layer === "coding");
    const codingEarlier = earlierLow.filter((claim) => claim.layer === "coding");
    const shouldProposeCoding =
      codingClaims.some((claim) => claim.confidence === "high") ||
      (codingClaims.some((claim) => claim.confidence === "low") && codingEarlier.length > 0);
    if (shouldProposeCoding && portrait.codingProposals && portrait.saveCodingProposals) {
      const addedProposals = await proposeCodingRules(ctx.llm, {
        day: ctx.day,
        coding: before.coding,
        portrait,
        claims: codingClaims,
        pending: codingEarlier,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        complete: stageCache.complete,
      });
      if (addedProposals > 0) {
        await ctx.emit("reminder.issued", {
          reminderId: `portrait-coding-proposals-${ctx.day}`,
          kind: "portrait_coding_proposal",
          topicId: null,
          text: `编码分身新增 ${addedProposals} 条待确认规则提案，可在数字分身页或运行 you-brain portrait-proposals 审核`,
        });
      }
    }

    // 2. Resident merge: persona claims + explicit full/coding corrections (without sending 60KB projects.md).
    const personaClaims = dedupeStoredClaims([
      ...earlierHigh.filter((claim) => claim.layer === "persona"),
      ...claims.filter((claim) => claim.layer === "persona"),
    ]);
    const personaEarlier = earlierLow.filter((claim) => claim.layer === "persona");
    const residentCorrections = corrections.filter((item) => item.variant !== "projects");
    const codingCorrections = residentCorrections.filter((item) => item.variant === "coding");
    const shouldMergeResident =
      personaClaims.some((claim) => claim.confidence === "high") ||
      (personaClaims.some((claim) => claim.confidence === "low") && personaEarlier.length > 0) ||
      residentCorrections.length > 0;

    // 3. Per-project local merge: only touched project groups are sent and rewritten.
    const projectClaims = dedupeStoredClaims([
      ...earlierHigh.filter((claim) => claim.layer === "project"),
      ...claims.filter((claim) => claim.layer === "project"),
    ]);
    const projectEarlier = earlierLow.filter((claim) => claim.layer === "project");
    const projectCorrections = corrections.filter((item) => item.variant === "projects");
    const shouldMergeProjects =
      projectClaims.some((claim) => claim.confidence === "high") ||
      (projectClaims.some((claim) => claim.confidence === "low") && projectEarlier.length > 0) ||
      projectCorrections.length > 0;

    if (!shouldMergeResident && !shouldMergeProjects) {
      if (input.chunks.length > 0 || earlierHigh.length > 0) {
        await portrait.saveClaims({
          name: ctx.day,
          claims,
          pending: [...earlierLow, ...low],
        });
      }
      ctx.cursors.set(PORTRAIT_TURNS_CURSOR, JSON.stringify(input.cursor));
      stageCache.clear();
      return;
    }

    let workingTexts: TwinTexts = before;
    let combinedBump: VersionBump = "patch";
    const combinedChangelog: string[] = [];
    const includedCorrectionIds: string[] = [];

    if (shouldMergeResident) {
      const residentPrompt = buildTwinMergePrompt({
        day: ctx.day,
        docs: { full: workingTexts.full, coding: workingTexts.coding },
        claims: personaClaims,
        pending: personaEarlier,
        corrections: residentCorrections,
      });
      const residentUpdate = await stageCache.complete(
        "resident_merge",
        ctx.llm,
        residentPrompt,
        TWIN_EDITS_JSON_SCHEMA,
        parseTwinEdits,
        ctx.signal,
      );
      const allowedEdits =
        codingCorrections.length > 0
          ? residentUpdate.edits
          : residentUpdate.edits.filter((edit) => edit.layer !== "coding");
      workingTexts = applyEditsWithIndex(workingTexts, allowedEdits);
      combinedBump = higherBump(combinedBump, residentUpdate.bump);
      combinedChangelog.push(...residentUpdate.changelog);
      includedCorrectionIds.push(...residentPrompt.includedCorrectionIds);
    }

    if (shouldMergeProjects) {
      const targetProjectsText = selectTargetProjectSections(
        workingTexts.projects,
        projectClaims,
        projectCorrections,
      );
      const projectPrompt = buildTwinProjectMergePrompt({
        day: ctx.day,
        targetProjectsText,
        claims: projectClaims,
        pending: projectEarlier,
        corrections: projectCorrections,
      });
      const projectUpdate = await stageCache.complete(
        "project_merge",
        ctx.llm,
        projectPrompt,
        TWIN_EDITS_JSON_SCHEMA,
        parseTwinEdits,
        ctx.signal,
      );
      const projectEdits = projectUpdate.edits.filter((edit) => edit.layer === "projects");
      workingTexts = applyEditsWithIndex(workingTexts, projectEdits);
      combinedBump = higherBump(combinedBump, projectUpdate.bump);
      combinedChangelog.push(...projectUpdate.changelog);
      includedCorrectionIds.push(...projectPrompt.includedCorrectionIds);
    }

    const merged: MergeResult = {
      texts: workingTexts,
      bump: combinedBump,
      changelog: combinedChangelog.slice(0, 8),
      includedCorrectionIds,
    };
    const outcome = await finishTwin(ctx.llm, before, merged.texts, {
      guardShrink: true,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      complete: stageCache.complete,
    });
    if ("skip" in outcome) {
      if (input.chunks.length > 0 || earlierHigh.length > 0) {
        const unmergedHigh = [...personaClaims, ...projectClaims].filter(
          (claim) => claim.confidence === "high" && !hasSensitiveHit(claim.text),
        );
        await portrait.saveClaims({
          name: ctx.day,
          claims,
          pending: dedupeStoredClaims([...earlierLow, ...low, ...unmergedHigh]),
        });
      }
      ctx.warnings.push(outcome.skip);
      ctx.cursors.set(PORTRAIT_TURNS_CURSOR, JSON.stringify(input.cursor));
      stageCache.clear();
      return;
    }
    let written: WrittenTwin | null = null;
    if (outcome.changed.size > 0) {
      try {
        written = await writeTwin(portrait, {
          day: ctx.day,
          files,
          after: outcome.texts,
          changed: outcome.changed,
          bump: merged.bump,
          changelog: merged.changelog,
          sizes: outcome.sizes,
        });
      } catch (error) {
        if (error instanceof ConflictError) {
          ctx.warnings.push("数字分身在沉淀期间被别处更新，已跳过");
          stageCache.clear();
          return;
        }
        throw error;
      }
      for (const warning of outcome.warnings) ctx.warnings.push(warning);
    }
    if (input.chunks.length > 0 || earlierHigh.length > 0) {
      await portrait.saveClaims({
        name: ctx.day,
        claims,
        pending: [...earlierLow, ...low],
      });
    }
    ctx.cursors.set(PORTRAIT_TURNS_CURSOR, JSON.stringify(input.cursor));
    stageCache.clear();
    const applied = new Set(merged.includedCorrectionIds);
    for (const correction of corrections) {
      if (!applied.has(correction.correctionId)) continue;
      await ctx.emit("portrait.correction_applied", {
        correctionId: correction.correctionId,
        snapshot: written?.snapshot ?? `v${twinVersionText(before)}`,
      });
    }
    if (written && written.notify) {
      await ctx.emit("reminder.issued", {
        reminderId: `portrait-v${written.version}`,
        kind: "portrait_updated",
        topicId: null,
        text: written.notice,
      });
    }
  },
};

export const portraitEvalStep: ConsolidationStep = {
  id: "portrait_eval",
  dependsOn: ["portrait"],
  async run(ctx) {
    const portrait = ctx.portrait;
    if (!portrait) return;
    const last = parseEvalCursor(ctx.cursors.get(PORTRAIT_EVAL_CURSOR));
    if (last && last.day > shiftDateKey(ctx.day, -EVAL_INTERVAL_DAYS)) return;
    const result = await evaluateTwin({
      llm: ctx.llm,
      portrait,
      day: ctx.day,
      newProbes: WEEKLY_PROBES,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!result) return;
    const { twin } = result.current;
    ctx.cursors.set(
      PORTRAIT_EVAL_CURSOR,
      JSON.stringify({ day: ctx.day, pass: twin.pass, total: twin.total, ...result.sizes }),
    );
    const notes: string[] = [];
    if (twin.total > 0) {
      await portrait.appendChangelog(twinEvalLog(ctx.day, result));
      if (last && last.total > 0) {
        const before = last.pass / last.total;
        const now = twin.pass / twin.total;
        if (now < before) notes.push(`保真评测得分从 ${last.pass}/${last.total} 降到 ${twin.pass}/${twin.total}`);
        const grew = result.sizes.full + result.sizes.coding > last.full + last.coding;
        if (grew && now <= before) notes.push("常驻层变长了，评测得分没有上升");
      }
      if (result.heldOut && lift(result.heldOut) <= 0) notes.push("留出题上分身没有比对照答得更好");
    }
    if (result.pending > 0) {
      notes.push(`有 ${result.pending} 道新评测题等你过目，可在数字分身页或运行 you-brain portrait-probes 审核`);
    }
    if (notes.length > 0) {
      const failed = twin.total > 0 ? `答错的题：${twin.failed.join("、") || "无"}` : "";
      await ctx.emit("reminder.issued", {
        reminderId: `portrait-eval-${ctx.day}`,
        kind: "portrait_eval",
        topicId: null,
        text: `${notes.join("；")}。${failed}`,
      });
    }
  },
};

export interface TwinEvalScore {
  pass: number;
  total: number;
  failed: string[];
}

/** The same probes answered with a twin, with no profile at all, and with a generic engineer profile. */
export interface TwinEvalScores {
  twin: TwinEvalScore;
  blank: TwinEvalScore;
  generic: TwinEvalScore;
}

export interface TwinEvalResult {
  added: number;
  /** Probes waiting for the user's review after this run, new ones included. */
  pending: number;
  /** Every probe, answered with the current twin. */
  current: TwinEvalScores;
  /** Dated probes, each answered with the twin from before the sessions it was written from. */
  heldOut: TwinEvalScores | null;
  /** Probes that cannot tell the twin from the baselines this run: all three right, or all three wrong. */
  flat: { right: string[]; wrong: string[] };
  sizes: { full: number; coding: number };
}

/**
 * Write up to `newProbes` probes from the past week's sessions for the user to review, then
 * score every reviewed probe against the current twin, the twin from before each probe's week,
 * and the two baselines (spec §7).
 */
export async function evaluateTwin(input: {
  llm: LlmBackend;
  portrait: ConsolidationPortrait;
  day: string;
  newProbes: number;
  signal?: AbortSignal;
}): Promise<TwinEvalResult | null> {
  const { llm, portrait, day, signal } = input;
  const files = await portrait.read();
  if (!files.full || !files.coding) return null;
  const sizes = { full: byteSize(files.full.text), coding: byteSize(files.coding.text) };

  const probes = await portrait.probes();
  let pending = await portrait.pendingProbes();
  let added = 0;
  if (input.newProbes > 0) {
    const turns = probeTurns(await portrait.sessions(shiftDateKey(day, 1 - EVAL_INTERVAL_DAYS)));
    if (turns !== "") {
      const existing = [...probes, ...pending];
      const prompt = buildTwinProbesPrompt({ turns, existing, limit: input.newProbes });
      const drafts = (await completeJson(llm, prompt, TWIN_PROBES_JSON_SCHEMA, parseTwinProbes, signal)).slice(
        0,
        input.newProbes,
      );
      if (drafts.length > 0) {
        let next = nextProbeNumber(existing);
        pending = [...pending, ...drafts.map((draft) => ({ id: `p${String(next++).padStart(2, "0")}`, ...draft, day }))];
        await portrait.savePendingProbes(pending);
        added = drafts.length;
      }
    }
  }
  if (probes.length === 0) {
    const none = { pass: 0, total: 0, failed: [] };
    return {
      added,
      pending: pending.length,
      current: { twin: none, blank: none, generic: none },
      heldOut: null,
      flat: { right: [], wrong: [] },
      sizes,
    };
  }

  const current: TwinEvalScores = {
    twin: await scoreProbes(llm, twinProfile(files.full.text, files.coding.text), probes),
    blank: await scoreProbes(llm, [], probes),
    generic: await scoreProbes(llm, [{ title: "人设", text: TWIN_EVAL_GENERIC_PERSONA }], probes),
  };
  const flat = flatProbes(probes, current);
  const marked = probes.map(({ flat: _, ...probe }): TwinProbe =>
    flat.right.includes(probe.id) || flat.wrong.includes(probe.id) ? { ...probe, flat: day } : probe,
  );
  if (marked.some((probe, index) => probe.flat !== probes[index]?.flat)) {
    await portrait.saveProbes(marked);
  }

  // The daemon reads sessions from one day before the window, so the held-out twin predates that day too.
  const groups = new Map<string, TwinProbe[]>();
  for (const probe of probes) {
    if (probe.day === undefined) continue;
    const before = shiftDateKey(probe.day, -EVAL_INTERVAL_DAYS);
    groups.set(before, [...(groups.get(before) ?? []), probe]);
  }
  let heldOut: TwinEvalScores | null = null;
  if (groups.size > 0 && portrait.twinBefore) {
    const scores: TwinEvalScore[] = [];
    const scored = new Set<string>();
    for (const [before, group] of groups) {
      const old = await portrait.twinBefore(before);
      if (!old) continue;
      scores.push(await scoreProbes(llm, twinProfile(old.full, old.coding), group));
      for (const probe of group) scored.add(probe.id);
    }
    if (scored.size > 0) {
      heldOut = {
        twin: {
          pass: scores.reduce((sum, score) => sum + score.pass, 0),
          total: scored.size,
          failed: scores.flatMap((score) => score.failed),
        },
        blank: scoreSubset(current.blank, scored),
        generic: scoreSubset(current.generic, scored),
      };
    }
  }
  return { added, pending: pending.length, current, heldOut, flat, sizes };
}

/**
 * Walk the probes waiting for review. Kept probes join the scored set, dropped ones are gone,
 * and a probe the user skips stays pending.
 */
export async function reviewProbes(input: {
  portrait: ConsolidationPortrait;
  decide: (probe: TwinProbe) => Promise<boolean | null>;
}): Promise<{ kept: number; dropped: number; left: number }> {
  const kept: TwinProbe[] = [];
  const left: TwinProbe[] = [];
  let dropped = 0;
  for (const probe of await input.portrait.pendingProbes()) {
    const verdict = await input.decide(probe);
    if (verdict === true) kept.push(probe);
    else if (verdict === false) dropped += 1;
    else left.push(probe);
  }
  // Kept probes are saved first, so a failure in between leaves them pending rather than lost.
  if (kept.length > 0) {
    const ids = new Set(kept.map((probe) => probe.id));
    const scored = (await input.portrait.probes()).filter((probe) => !ids.has(probe.id));
    await input.portrait.saveProbes([...scored, ...kept]);
  }
  if (kept.length + dropped > 0) await input.portrait.savePendingProbes(left);
  return { kept: kept.length, dropped, left: left.length };
}

function flatProbes(probes: readonly TwinProbe[], scores: TwinEvalScores): TwinEvalResult["flat"] {
  const failed = [scores.twin.failed, scores.blank.failed, scores.generic.failed].map((ids) => new Set(ids));
  const ids = probes.map((probe) => probe.id);
  return {
    right: ids.filter((id) => failed.every((set) => !set.has(id))),
    wrong: ids.filter((id) => failed.every((set) => set.has(id))),
  };
}

export function twinEvalLog(day: string, result: TwinEvalResult): string {
  const lines = [
    `## 评测 · ${day}`,
    scoreLine(`全部 ${result.current.twin.total} 道，当前分身作答`, result.current),
  ];
  if (result.heldOut) {
    lines.push(scoreLine(`留出 ${result.heldOut.twin.total} 道，出题前一周的分身作答`, result.heldOut));
  }
  if (result.added > 0 || result.pending > 0) {
    lines.push(`- 新出 ${result.added} 道题，${result.pending} 道等你过目后才计分`);
  }
  const { right, wrong } = result.flat;
  if (right.length + wrong.length > 0) {
    const parts = [
      ...(right.length > 0 ? [`三组都答对 ${right.join("、")}`] : []),
      ...(wrong.length > 0 ? [`三组都答错 ${wrong.join("、")}`] : []),
    ];
    lines.push(`- 没有区分度 ${right.length + wrong.length} 道：${parts.join("；")}`);
  }
  lines.push(`- 常驻层 full ${result.sizes.full} 字节，coding ${result.sizes.coding} 字节`);
  if (result.current.twin.failed.length > 0) {
    lines.push(`- 当前分身答错：${result.current.twin.failed.join("、")}`);
  }
  return lines.join("\n");
}

/** How many more probes the twin got right than the better of the two baselines. */
function lift(scores: TwinEvalScores): number {
  return scores.twin.pass - Math.max(scores.blank.pass, scores.generic.pass);
}

function scoreLine(label: string, scores: TwinEvalScores): string {
  const gap = lift(scores);
  const verdict =
    gap > 0
      ? `比两组对照里较好的多答对 ${gap} 道`
      : gap < 0
        ? `比两组对照里较好的少答对 ${-gap} 道`
        : "和两组对照里较好的持平";
  return `- ${label}：分身 ${scores.twin.pass}，不读分身 ${scores.blank.pass}，通用人设 ${scores.generic.pass}；${verdict}`;
}

function twinProfile(full: string, coding: string): Array<{ title: string; text: string }> {
  return [
    { title: "人格分身", text: full },
    { title: "编码分身", text: coding },
  ];
}

/**
 * A probe passes when most of `EVAL_ROUNDS` rounds of answering and judging pass it. A probe
 * leaves the loop once one side has a majority, so the last round only covers split probes.
 */
async function scoreProbes(
  llm: LlmBackend,
  profile: readonly { title: string; text: string }[],
  probes: readonly TwinProbe[],
): Promise<TwinEvalScore> {
  const majority = Math.floor(EVAL_ROUNDS / 2) + 1;
  const passes = new Map<string, number>();
  const fails = new Map<string, number>();
  let open = [...probes];
  for (let round = 0; round < EVAL_ROUNDS && open.length > 0; round += 1) {
    const passed = await scoreRound(llm, profile, open);
    for (const probe of open) {
      const tally = passed.has(probe.id) ? passes : fails;
      tally.set(probe.id, (tally.get(probe.id) ?? 0) + 1);
    }
    open = open.filter(
      (probe) => (passes.get(probe.id) ?? 0) < majority && (fails.get(probe.id) ?? 0) < majority,
    );
  }
  const failed = probes.filter((probe) => (passes.get(probe.id) ?? 0) < majority).map((probe) => probe.id);
  return { pass: probes.length - failed.length, total: probes.length, failed };
}

/** One answer call and one blind judge call; returns the ids that passed. */
async function scoreRound(
  llm: LlmBackend,
  profile: readonly { title: string; text: string }[],
  probes: readonly TwinProbe[],
): Promise<Set<string>> {
  const answers = await completeJson(
    llm,
    buildTwinEvalAnswerPrompt({ profile, probes }),
    TWIN_EVAL_ANSWERS_JSON_SCHEMA,
    parseTwinAnswers,
  );
  const verdicts = await completeJson(
    llm,
    buildTwinEvalJudgePrompt({
      items: probes.map((probe) => ({
        id: probe.id,
        situation: probe.situation,
        expect: probe.expect,
        answer: answers.get(probe.id) ?? "",
      })),
    }),
    TWIN_EVAL_JUDGE_JSON_SCHEMA,
    parseTwinJudge,
  );
  return new Set(probes.filter((probe) => verdicts.get(probe.id) === true).map((probe) => probe.id));
}

function scoreSubset(score: TwinEvalScore, ids: ReadonlySet<string>): TwinEvalScore {
  const failed = score.failed.filter((id) => ids.has(id));
  return { pass: ids.size - failed.length, total: ids.size, failed };
}

/**
 * The week's user turns for the probe writer, rendered oldest first. Newest sessions and each
 * session's latest turns go in first, so one long session cannot fill the budget.
 */
function probeTurns(sessions: ReadonlyArray<{ title: string; turns: readonly string[] }>): string {
  const pieces: string[] = [];
  let used = 0;
  for (const session of [...sessions].reverse()) {
    const lines: string[] = [];
    let share = 0;
    for (let index = session.turns.length - 1; index >= 0; index -= 1) {
      const text = cleanUserTurn(session.turns[index] ?? "");
      if (text === "") continue;
      const size = textUnits(text) + 2;
      if (share + size > PROBE_SESSION_UNITS || used + size > PROBE_INPUT_UNITS) break;
      lines.unshift(`- ${text}`);
      share += size;
      used += size;
    }
    if (lines.length > 0) pieces.unshift([`### ${session.title.trim() || "（无标题）"}`, ...lines].join("\n"));
  }
  return pieces.join("\n\n");
}

export const PORTRAIT_MONTHLY_CURSOR = "portrait.monthly";
/** How far apart monthly comparisons sit, in days (spec §8). */
const MONTHLY_INTERVAL_DAYS = 30;

function parseMonthlyCursor(raw: string | null): { day: string; pass: number; total: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.day !== "string") return null;
    const number = (value: unknown) => (typeof value === "number" ? value : 0);
    return { day: parsed.day, pass: number(parsed.pass), total: number(parsed.total) };
  } catch {
    return null;
  }
}

/**
 * Compare the full layer against the snapshot closest to a month back and note which
 * values and rules moved, plus how the eval score changed (spec §8). The summary goes
 * into the changelog and out through the portrait reminder channel.
 */
export const portraitMonthlyStep: ConsolidationStep = {
  id: "portrait_monthly",
  dependsOn: ["portrait_eval"],
  async run(ctx) {
    const portrait = ctx.portrait;
    if (!portrait?.snapshots || !portrait.readSnapshot) return;
    const last = parseMonthlyCursor(ctx.cursors.get(PORTRAIT_MONTHLY_CURSOR));
    if (last && last.day > shiftDateKey(ctx.day, -MONTHLY_INTERVAL_DAYS)) return;
    const files = await portrait.read();
    if (!files.full) return;
    const evalNow = parseEvalCursor(ctx.cursors.get(PORTRAIT_EVAL_CURSOR));
    const target = shiftDateKey(ctx.day, -MONTHLY_INTERVAL_DAYS);
    const snapshots = await portrait.snapshots();
    const base = snapshots
      .filter((snapshot) => snapshot.day !== "" && snapshot.day <= target)
      .sort((left, right) => right.day.localeCompare(left.day))[0];
    if (base === undefined) {
      // Nothing a month old yet: start the window now so the next run has a baseline.
      ctx.cursors.set(
        PORTRAIT_MONTHLY_CURSOR,
        JSON.stringify({ day: ctx.day, pass: evalNow?.pass ?? 0, total: evalNow?.total ?? 0 }),
      );
      return;
    }
    const before = await portrait.readSnapshot(base.file);
    if (before === null) return;
    const prompt = buildTwinMonthlyPrompt({ before, after: files.full.text });
    const notes = await completeJson(ctx.llm, prompt, TWIN_MONTHLY_JSON_SCHEMA, parseTwinMonthly, ctx.signal);
    const lines = [`## 月度对比 · ${ctx.day}`, `- 对比基准 ${base.day}（v${base.version}）`];
    if (notes.length === 0) lines.push("- 没有实质变化");
    lines.push(...notes.map((note) => `- ${note}`));
    if (last && last.total > 0 && evalNow !== null && evalNow.total > 0) {
      lines.push(`- 评测得分 ${last.pass}/${last.total} → ${evalNow.pass}/${evalNow.total}`);
    }
    await portrait.appendChangelog(lines.join("\n"));
    const headline = notes.slice(0, 2).join("；");
    await ctx.emit("reminder.issued", {
      reminderId: `portrait-monthly-${ctx.day}`,
      kind: "portrait_monthly",
      topicId: null,
      text:
        headline === ""
          ? `数字分身月度对比：与 ${base.day} 相比没有实质变化`
          : `数字分身月度对比：${headline}（详见 changelog）`,
    });
    ctx.cursors.set(
      PORTRAIT_MONTHLY_CURSOR,
      JSON.stringify({ day: ctx.day, pass: evalNow?.pass ?? last?.pass ?? 0, total: evalNow?.total ?? last?.total ?? 0 }),
    );
  },
};

export interface RebuildTwinInput {
  llm: LlmBackend;
  portrait: ConsolidationPortrait;
  day: string;
  log?: (line: string) => void;
}

export interface RebuildTwinResult {
  version: string;
  sizes: { full: number; coding: number; maxSection: number };
  claims: number;
  warnings: string[];
}

/**
 * Rebuild the three layers from whatever the layer files hold now.
 * The old text becomes claims, and the claims are merged into fresh skeletons in batches.
 */
export async function rebuildTwin(input: RebuildTwinInput): Promise<RebuildTwinResult> {
  const log = input.log ?? (() => undefined);
  const files = await input.portrait.read();
  if (!files.full && !files.coding && !files.projects) throw new Error("没有现有数字分身，无法重建");
  const before = textsOf(files);
  const name = `rebuild-${input.day}`;
  let claims = await input.portrait.claimsOf([name]);
  if (claims.length > 0) {
    log(`复用今天已抽取的 ${claims.length} 条主张`);
  } else {
    const chunks = TWIN_LAYERS.flatMap((layer) => chunkDocument(before[layer]));
    log(`旧分身切成 ${chunks.length} 段，开始抽取主张`);
    claims = (
      await extractClaims(input.llm, chunks, "legacy", projectNames(before.projects), (done) =>
        log(`主张抽取 ${done}/${chunks.length}`),
      )
    ).map((claim) => ({ ...claim, day: input.day }));
    await input.portrait.saveClaims({ name, claims, pending: null });
  }
  const usable = claims.filter((claim) => claim.confidence === "high");
  log(`抽到 ${claims.length} 条主张，其中高置信 ${usable.length} 条`);

  let texts: TwinTexts = {
    full: skeletonTwin("full"),
    coding: skeletonTwin("coding"),
    projects: skeletonTwin("projects"),
  };
  const batches = rebuildBatches(usable);
  const changelog: string[] = [];
  for (const [index, batch] of batches.entries()) {
    log(`合并第 ${index + 1}/${batches.length} 批（${batch.length} 条）`);
    const merged = await mergeOnce(input.llm, {
      day: input.day,
      docs: texts,
      claims: batch,
      pending: [],
      corrections: [],
    });
    texts = merged.texts;
    const check = checkTwin(texts, new Set(TWIN_LAYERS));
    if (check.blocking.length > 0) {
      log(`第 ${index + 1} 批后需要修正：${check.blocking.join("；")}`);
      texts = await fixOnce(input.llm, texts, check.blocking);
    }
    if (index === 0) changelog.push(...merged.changelog.slice(0, 2));
  }
  // Squeezing some 1500 rules into the budget can take more than the one pass finishTwin gives.
  for (let pass = 1; pass <= REBUILD_FIX_PASSES; pass += 1) {
    const check = checkTwin(texts, new Set(TWIN_LAYERS));
    if (check.blocking.length === 0) break;
    log(`收尾修正第 ${pass} 轮：${check.blocking.join("；")}`);
    texts = await fixOnce(input.llm, texts, check.blocking);
  }
  const outcome = await finishTwin(input.llm, before, texts, { guardShrink: false });
  if ("skip" in outcome) throw new Error(outcome.skip);
  const oldVersion = twinVersionText(before);
  const written = await writeTwin(input.portrait, {
    day: input.day,
    files,
    after: outcome.texts,
    changed: new Set(TWIN_LAYERS),
    bump: "major",
    changelog: [
      `从 v${oldVersion} 重建为三层：人格分身 full、编码分身 coding、项目决定 projects；不再生成 brief`,
      `由 ${claims.length} 条主张重新合并，每条规则只住在一层`,
    ],
    sizes: outcome.sizes,
  });
  return { version: written.version, sizes: outcome.sizes, claims: claims.length, warnings: outcome.warnings };
}

interface MergeInput {
  day: string;
  docs: TwinTexts;
  claims: readonly StoredTwinClaim[];
  pending: readonly StoredTwinClaim[];
  corrections: readonly TwinPromptCorrection[];
}

interface MergeResult {
  texts: TwinTexts;
  bump: VersionBump;
  changelog: string[];
  includedCorrectionIds: string[];
}

async function mergeOnce(llm: LlmBackend, input: MergeInput): Promise<MergeResult> {
  const prompt = buildTwinMergePrompt(input);
  const update = await completeJson(llm, prompt, TWIN_EDITS_JSON_SCHEMA, parseTwinEdits);
  return {
    texts: withIndex(applyTwinEdits(input.docs, update.edits)),
    bump: update.bump,
    changelog: update.changelog,
    includedCorrectionIds: prompt.includedCorrectionIds,
  };
}

/** Max wait for an advisory-only fix pass before falling back to the valid merged text. */
const ADVISORY_FIX_TIMEOUT_MS = 90_000;

async function fixOnce(
  llm: LlmBackend,
  texts: TwinTexts,
  problems: readonly string[],
  signal?: AbortSignal,
  complete?: StageCompleter,
): Promise<TwinTexts> {
  const hasFullProblem = problems.some((problem) => /\bfull\b/u.test(problem));
  const hasCodingProblem = problems.some((problem) => /\bcoding\b/u.test(problem));
  const hasProjectsProblem = problems.some((problem) => /\bprojects\b/u.test(problem));
  const projectsOnly = hasProjectsProblem && !hasFullProblem && !hasCodingProblem;
  const isLargeProjects = byteSize(texts.projects) > 16_384;
  const omitLargeProjects = isLargeProjects && !hasProjectsProblem;
  const scopedProjects =
    isLargeProjects && hasProjectsProblem ? scopeProblemProjects(texts.projects, problems) : texts.projects;
  const promptDocs: TwinTexts = {
    full: projectsOnly ? "" : texts.full,
    coding: projectsOnly ? "" : texts.coding,
    projects: omitLargeProjects ? "" : scopedProjects,
  };
  const prompt = buildTwinFixPrompt({ docs: promptDocs, problems });
  const update: TwinEditsUpdate = complete
    ? await complete("fix", llm, prompt, TWIN_EDITS_JSON_SCHEMA, parseTwinEdits, signal)
    : await completeJson(llm, prompt, TWIN_EDITS_JSON_SCHEMA, parseTwinEdits, signal);
  const safeEdits = update.edits.filter((edit) => {
    if (projectsOnly && edit.layer !== "projects") return false;
    if (omitLargeProjects && edit.layer === "projects") return false;
    return true;
  });
  return applyEditsWithIndex(texts, safeEdits);
}

function scopeProblemProjects(projectsText: string, problems: readonly string[]): string {
  const { groups } = parseProjectGroups(projectsText);
  const problemBlob = problems.join("\n");
  const matched = groups.filter(
    (group) =>
      problemBlob.includes(group.name) ||
      group.sections.some(
        (sec) => problemBlob.includes(sec.heading) || /待确认|不升格|两条都有效|证据 ?ID|样本数/u.test(sec.text),
      ),
  );
  if (matched.length === 0) return projectsText;
  return matched.flatMap((group) => group.sections.map((sec) => sec.text)).join("\n\n");
}

function higherBump(left: VersionBump, right: VersionBump): VersionBump {
  const rankBump = (bump: VersionBump) => (bump === "major" ? 2 : bump === "minor" ? 1 : 0);
  return rankBump(right) > rankBump(left) ? right : left;
}

async function proposeCodingRules(
  llm: LlmBackend,
  input: {
    day: string;
    coding: string;
    portrait: ConsolidationPortrait;
    claims: readonly StoredTwinClaim[];
    pending: readonly StoredTwinClaim[];
    signal?: AbortSignal;
    complete?: StageCompleter;
  },
): Promise<number> {
  if (!input.portrait.codingProposals || !input.portrait.saveCodingProposals) return 0;
  const existing = await input.portrait.codingProposals();
  const prompt = buildTwinCodingProposalsPrompt({
    day: input.day,
    coding: input.coding,
    existingProposals: existing,
    claims: input.claims,
    pending: input.pending,
  });
  const drafts = input.complete
    ? await input.complete(
        "coding_proposals",
        llm,
        prompt,
        TWIN_CODING_PROPOSALS_JSON_SCHEMA,
        parseTwinCodingProposals,
        input.signal,
        // Key by stable inputs rather than `existingProposals` so a retry after proposals were
        // already persisted still hits cache and runs idempotent dedupe without re-calling the LLM.
        JSON.stringify({
          stage: "coding_proposals",
          day: input.day,
          coding: input.coding,
          claims: input.claims,
          pending: input.pending,
          schema: TWIN_CODING_PROPOSALS_JSON_SCHEMA,
        }),
      )
    : await completeJson(
        llm,
        prompt,
        TWIN_CODING_PROPOSALS_JSON_SCHEMA,
        parseTwinCodingProposals,
        input.signal,
      );
  if (drafts.length === 0) return 0;

  const seenLines = new Set(existing.map((item) => normalizeCodingRuleLine(item.proposedLine)));
  let nextNum = nextCodingProposalNumber(existing);
  const added: CodingRuleProposal[] = [];
  for (const draft of drafts) {
    const normalized = normalizeCodingRuleLine(draft.proposedLine);
    if (seenLines.has(normalized)) continue;
    seenLines.add(normalized);
    added.push({
      id: `cp${String(nextNum++).padStart(2, "0")}`,
      day: input.day,
      section: draft.section,
      action: draft.action,
      ...(draft.targetLine ? { targetLine: draft.targetLine } : {}),
      proposedLine: normalized,
      reason: draft.reason,
    });
  }
  if (added.length === 0) return 0;
  await input.portrait.saveCodingProposals([...existing, ...added]);
  return added.length;
}

function selectTargetProjectSections(
  projectsText: string,
  claims: readonly StoredTwinClaim[],
  corrections: readonly TwinPromptCorrection[],
): string {
  if (projectsText.trim() === "") return "";
  const { groups } = parseProjectGroups(projectsText);
  const targetNames = new Set<string>();
  const targetRepos = new Set<string>();
  for (const claim of claims) {
    if (claim.project.trim() !== "") targetNames.add(claim.project.trim().toLowerCase());
    if (claim.repo && claim.repo.trim() !== "") targetRepos.add(claim.repo.trim().toLowerCase());
  }
  for (const correction of corrections) {
    const prefix = projectPrefixOfHeading(correction.section);
    if (prefix) targetNames.add(prefix.toLowerCase());
  }

  const matched = groups.filter((group) => {
    const nameLower = group.name.toLowerCase();
    if (targetNames.has(nameLower)) return true;
    if (group.repos.some((repo) => targetRepos.has(repo.toLowerCase()) || targetNames.has(repo.toLowerCase()))) {
      return true;
    }
    return corrections.some((correction) => correction.text.toLowerCase().includes(nameLower));
  });
  return matched.flatMap((group) => group.sections.map((section) => section.text)).join("\n\n");
}

/**
 * Initialize or replace `coding.md` from a hand-crafted `AGENTS.md` / `CLAUDE.md` file,
 * checking against the coding twin budget and standard before writing to Drive.
 */
export async function seedCodingTwin(input: {
  portrait: ConsolidationPortrait;
  sourceMarkdown: string;
  day: string;
}): Promise<{ version: string; text: string; bytes: number }> {
  const files = await input.portrait.read();
  const before = textsOf(files);
  const nextVersion = bumpVersion(twinVersion(before), "minor");
  const seeded = seedCodingFromMarkdown(input.sourceMarkdown, nextVersion, input.day);
  const candidate: TwinTexts = { ...before, coding: seeded };
  const check = checkTwin(candidate, new Set(["coding"]));
  check.blocking.push(...twinStandardProblems("coding", seeded));
  if (check.blocking.length > 0) {
    throw new Error(`编码分身基线未通过质量检查：${check.blocking.join("；")}`);
  }
  if (check.scanHits.length > 0) {
    throw new Error(`编码分身基线包含疑似敏感信息：${check.scanHits.join("、")}`);
  }
  const entry = [
    `## v${nextVersion} · ${input.day}`,
    "- coding：从手写 AGENTS.md / CLAUDE.md 导入四节编码分身基线",
    `- 体积：full ${check.sizes.full} 字节，coding ${check.sizes.coding} 字节，projects 最大小节 ${check.sizes.maxSection} 字节`,
  ].join("\n");
  await input.portrait.save({
    day: input.day,
    version: nextVersion,
    files: [
      {
        layer: "coding",
        text: seeded,
        previous: files.coding,
      },
    ],
    changelog: entry,
  });
  return { version: nextVersion, text: seeded, bytes: check.sizes.coding };
}

function withIndex(texts: TwinTexts): TwinTexts {
  return { ...texts, coding: withProjectsPointer(texts.coding) };
}

function applyEditsWithIndex(texts: TwinTexts, edits: readonly { layer: TwinLayer; heading: string; text: string }[]): TwinTexts {
  const next = applyTwinEdits(texts, edits);
  return edits.some((edit) => edit.layer === "coding")
    ? { ...next, coding: withProjectsPointer(next.coding) }
    : next;
}

type FinishOutcome =
  | { skip: string }
  | {
      texts: TwinTexts;
      changed: Set<TwinLayer>;
      warnings: string[];
      sizes: { full: number; coding: number; maxSection: number };
    };

/**
 * The write-time check plus the quality standard (twin-standard.ts) for the resident layers.
 * The standard holds a layer only once its current text meets it: a layer still in an older
 * shape is not blocked forever, and a layer that meets it can never slip back.
 */
function checkWithStandard(before: TwinTexts, texts: TwinTexts, changed: ReadonlySet<TwinLayer>): TwinCheck {
  const check = checkTwin(texts, changed, before);
  for (const layer of ["full", "coding"] as const) {
    if (!changed.has(layer) || twinStandardProblems(layer, before[layer]).length > 0) continue;
    check.blocking.push(...twinStandardProblems(layer, texts[layer]));
  }
  if (
    (changed.has("full") || changed.has("coding")) &&
    twinCrossLayerProblems(before.full, before.coding).length === 0
  ) {
    check.blocking.push(...twinCrossLayerProblems(texts.full, texts.coding));
  }
  return check;
}

function shrinkSkipReason(
  before: TwinTexts,
  texts: TwinTexts,
  changed: ReadonlySet<TwinLayer>,
): string | null {
  for (const layer of changed) {
    const previous = twinBody(before[layer]);
    if (previous !== "" && textUnits(twinBody(texts[layer])) * 2 < textUnits(previous)) {
      return `数字分身 ${layer} 输出不到原来的一半，已跳过`;
    }
  }
  return null;
}

/** Checks before writing, with one fix pass. Unchanged layers come back byte for byte. */
async function finishTwin(
  llm: LlmBackend,
  before: TwinTexts,
  merged: TwinTexts,
  options: { guardShrink: boolean; signal?: AbortSignal; complete?: StageCompleter },
): Promise<FinishOutcome> {
  let texts = merged;
  let changed = changedLayers(before, texts);
  if (changed.size === 0) return { texts: before, changed, warnings: [], sizes: checkTwin(before, changed).sizes };
  let check = checkWithStandard(before, texts, changed);
  const extraWarnings: string[] = [];
  if (check.blocking.length > 0) {
    texts = await fixOnce(llm, texts, [...check.blocking, ...check.warnings], options.signal, options.complete);
    changed = changedLayers(before, texts);
    check = checkWithStandard(before, texts, changed);
  } else if (check.warnings.length > 0) {
    // Blocking checks already pass: treat the warning-only fix pass as best-effort so a slow or
    // failing optimization rewrite never blocks writing the valid merged portrait.
    const advisoryController = new AbortController();
    const onParentAbort = () => advisoryController.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      advisoryController.abort(options.signal.reason);
    } else {
      options.signal?.addEventListener("abort", onParentAbort, { once: true });
    }
    const timer = setTimeout(() => advisoryController.abort(new Error("优化修正超时")), ADVISORY_FIX_TIMEOUT_MS);
    try {
      const candidate = await fixOnce(llm, texts, check.warnings, advisoryController.signal, options.complete);
      const candidateChanged = changedLayers(before, candidate);
      const candidateCheck = checkWithStandard(before, candidate, candidateChanged);
      const candidateShrink = options.guardShrink
        ? shrinkSkipReason(before, candidate, candidateChanged)
        : null;
      if (candidateCheck.blocking.length === 0 && candidateCheck.scanHits.length === 0 && candidateShrink === null) {
        texts = candidate;
        changed = candidateChanged;
        check = candidateCheck;
      } else {
        extraWarnings.push("数字分身优化修正未通过检查，已保留原合并结果写入");
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const detail = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
      extraWarnings.push(`数字分身优化修正未完成，已保留原合并结果写入${detail ? `（${detail}）` : ""}`);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onParentAbort);
    }
  }
  if (check.blocking.length > 0) return { skip: `数字分身没有通过写入前检查，已跳过：${check.blocking.join("；")}` };
  if (check.scanHits.length > 0) {
    return { skip: `数字分身里发现疑似敏感信息，已跳过：${check.scanHits.join("、")}` };
  }
  if (options.guardShrink) {
    const shrinkSkip = shrinkSkipReason(before, texts, changed);
    if (shrinkSkip !== null) return { skip: shrinkSkip };
  }
  const kept = { ...texts };
  for (const layer of TWIN_LAYERS) if (!changed.has(layer)) kept[layer] = before[layer];
  return { texts: kept, changed, warnings: [...check.warnings, ...extraWarnings], sizes: check.sizes };
}

interface WrittenTwin {
  version: string;
  snapshot: string | null;
  notify: boolean;
  notice: string;
}

async function writeTwin(
  portrait: ConsolidationPortrait,
  input: {
    day: string;
    files: Record<TwinLayer, TwinFileRef | null>;
    after: TwinTexts;
    changed: ReadonlySet<TwinLayer>;
    bump: VersionBump;
    changelog: readonly string[];
    sizes: { full: number; coding: number; maxSection: number };
  },
): Promise<WrittenTwin> {
  const before = textsOf(input.files);
  const version = bumpVersion(twinVersion(before), input.bump);
  const layers = TWIN_LAYERS.filter((layer) => input.changed.has(layer));
  const entry = [
    `## v${version} · ${input.day}`,
    ...(input.changelog.length > 0 ? input.changelog : [`更新 ${layers.join("、")}`]).map((line) => `- ${line}`),
    `- 体积：full ${input.sizes.full} 字节，coding ${input.sizes.coding} 字节，projects 最大小节 ${input.sizes.maxSection} 字节`,
  ].join("\n");
  const saved = await portrait.save({
    day: input.day,
    version,
    files: layers.map((layer) => ({
      layer,
      text: withHeader(layer, input.after[layer], version, input.day),
      previous: input.files[layer],
    })),
    changelog: entry,
  });
  const resident = (["full", "coding"] as const).filter(
    (layer) => input.changed.has(layer) && substantive(before[layer]) !== substantive(input.after[layer]),
  );
  const link = resident.map((layer) => saved.links[layer]).find((value) => value !== undefined);
  const summary = input.changelog.slice(0, 3).join("；") || `更新了 ${resident.join("、")}`;
  return {
    version,
    snapshot: saved.snapshot,
    notify: resident.length > 0,
    notice: `数字分身更新到 v${version}：${summary}${link ? ` ${link}` : ""}`,
  };
}

/** Body without the version line and the generated projects pointer. */
function substantive(text: string): string {
  return twinBody(withProjectsPointer(text));
}

function textsOf(files: Record<TwinLayer, TwinFileRef | null>): TwinTexts {
  return {
    full: files.full?.text ?? "",
    coding: files.coding?.text ?? "",
    projects: files.projects?.text ?? "",
  };
}

function twinVersionText(texts: TwinTexts): string {
  return twinVersion(texts).join(".");
}

function projectNames(projects: string): string[] {
  const names = new Set<string>();
  for (const section of splitTwin(projects).sections) {
    const name = section.heading.replace(/^##\s+/u, "").split(" · ")[0]?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

async function extractClaims(
  llm: LlmBackend,
  chunks: readonly string[],
  source: "sessions" | "legacy",
  projects: readonly string[],
  progress?: (done: number) => void,
  signal?: AbortSignal,
  complete?: StageCompleter,
): Promise<TwinClaim[]> {
  let done = 0;
  const results = await mapWithLimit(chunks, EXTRACT_CONCURRENCY, async (text) => {
    const prompt = buildTwinClaimsPrompt({ source, projects, text });
    const claims = complete
      ? await complete("extract", llm, prompt, TWIN_CLAIMS_JSON_SCHEMA, parseTwinClaims, signal)
      : await completeJson(llm, prompt, TWIN_CLAIMS_JSON_SCHEMA, parseTwinClaims, signal);
    done += 1;
    progress?.(done);
    return claims;
  });
  const seen = new Set<string>();
  return results.flat().filter((claim) => {
    if (seen.has(claim.text)) return false;
    seen.add(claim.text);
    return true;
  });
}

/** Claims grouped persona → coding → each project, packed into batches under the unit cap. */
function rebuildBatches(claims: readonly StoredTwinClaim[]): StoredTwinClaim[][] {
  const groups = new Map<string, StoredTwinClaim[]>();
  for (const claim of claims) {
    const key = claim.layer === "project" ? `project:${claim.project}` : claim.layer;
    const list = groups.get(key) ?? [];
    list.push(claim);
    groups.set(key, list);
  }
  const order = [...groups.keys()].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
  const batches: StoredTwinClaim[][] = [];
  let current: StoredTwinClaim[] = [];
  let used = 0;
  for (const key of order) {
    for (const claim of groups.get(key) ?? []) {
      const size = textUnits(claim.text) + 40;
      const switching = current.length > 0 && current[0]?.layer !== claim.layer;
      if (current.length > 0 && (used + size > REBUILD_BATCH_UNITS || switching)) {
        batches.push(current);
        current = [];
        used = 0;
      }
      current.push(claim);
      used += size;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function rank(key: string): number {
  if (key === "persona") return 0;
  if (key === "coding") return 1;
  return 2;
}

/** Split a document at `## ` headings into chunks under {@link CHUNK_UNITS}. */
function chunkDocument(text: string): string[] {
  if (text.trim() === "") return [];
  const doc = splitTwin(text);
  const pieces = [doc.head, ...doc.sections.map((section) => section.text)].flatMap((piece) =>
    textUnits(piece) <= CHUNK_UNITS ? [piece] : splitLines(piece),
  );
  return packPieces(pieces);
}

function splitLines(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let used = 0;
  for (const line of text.split("\n")) {
    const size = textUnits(line) + 1;
    if (current.length > 0 && used + size > CHUNK_UNITS) {
      out.push(current.join("\n"));
      current = [];
      used = 0;
    }
    current.push(textUnits(line) > CHUNK_UNITS ? clipUnits(line, CHUNK_UNITS) : line);
    used += size;
  }
  if (current.length > 0) out.push(current.join("\n"));
  return out;
}

function packPieces(pieces: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (piece.trim() === "") continue;
    if (current !== "" && textUnits(current) + textUnits(piece) + 2 > CHUNK_UNITS) {
      chunks.push(current);
      current = "";
    }
    current = current === "" ? piece : `${current}\n\n${piece}`;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

export type TurnCursor = Record<string, number>;

export function parseTurnCursor(raw: string | null): TurnCursor {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const cursor: TurnCursor = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) cursor[key] = value;
    }
    return cursor;
  } catch {
    return {};
  }
}

function hasSensitiveHit(text: string): boolean {
  return TWIN_SCAN.some((rule) => new RegExp(rule.pattern.source, rule.pattern.flags).test(text));
}

function dedupeStoredClaims(claims: readonly StoredTwinClaim[]): StoredTwinClaim[] {
  const seen = new Set<string>();
  const out: StoredTwinClaim[] = [];
  for (const claim of claims) {
    const key = `${claim.layer}\0${claim.project}\0${claim.confidence}\0${claim.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(claim);
  }
  return out;
}

export interface TurnSessionInput {
  sessionKey: string;
  title: string;
  turns: readonly string[];
}

export interface TurnAccumulator {
  add(session: TurnSessionInput): void;
  full(): boolean;
  finish(): { chunks: string[]; cursor: TurnCursor };
}

/**
 * Stateful accumulator shared by `readTwinSessions` (for early batch stop) and `collectTurns`.
 * Preserves the exact semantics: when one turn exceeds remaining budget, that session stops and
 * later sessions can still fill remaining space; only `used >= budgetUnits` marks full.
 */
const MIN_TURN_UNITS = 3;

export function createTurnAccumulator(
  seen: Readonly<Record<string, number>>,
  budgetUnits = DAY_UNITS,
): TurnAccumulator {
  const cursor: TurnCursor = { ...seen };
  const pieces: string[] = [];
  let used = 0;
  const isFull = (): boolean => used + MIN_TURN_UNITS > budgetUnits;
  return {
    add(session) {
      if (isFull()) return;
      const start = Math.min(seen[session.sessionKey] ?? 0, session.turns.length);
      const lines: string[] = [];
      let taken = start;
      for (let index = start; index < session.turns.length; index += 1) {
        const text = cleanUserTurn(session.turns[index] ?? "");
        const size = textUnits(text) + 2;
        if (text !== "" && used + size > budgetUnits) break;
        if (text !== "") {
          lines.push(`- ${text}`);
          used += size;
        }
        taken = index + 1;
      }
      cursor[session.sessionKey] = taken;
      if (lines.length > 0) {
        pieces.push([`### ${session.title.trim() || "（无标题）"}`, ...lines].join("\n"));
      }
    },
    full() {
      return isFull();
    },
    finish() {
      return {
        chunks: packPieces(
          pieces.flatMap((piece) => (textUnits(piece) <= CHUNK_UNITS ? [piece] : splitLines(piece))),
        ),
        cursor,
      };
    },
  };
}

/**
 * New user turns per session past the cursor, packed into extraction chunks.
 * Turns over the day's cap stay behind the cursor for the next run.
 */
export function collectTurns(
  sessions: ReadonlyArray<TurnSessionInput>,
  seen: TurnCursor,
): { chunks: string[]; cursor: TurnCursor } {
  const accumulator = createTurnAccumulator(seen, DAY_UNITS);
  for (const session of sessions) {
    if (accumulator.full()) break;
    accumulator.add(session);
  }
  return accumulator.finish();
}

const INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gu,
  /<(command|local-command)-[a-z-]+>[\s\S]*?<\/(command|local-command)-[a-z-]+>/gu,
  /<task-notification>[\s\S]*?<\/task-notification>/gu,
];
const INJECTED_TURNS = [
  /^This session is being continued/u,
  /^Caveat: /u,
];

/** The user's own words: injected context blocks, CLI control commands, and batch templates drop out. */
export function cleanUserTurn(raw: string): string {
  if (isInjectedPrompt(raw) || isCliControlTurn(raw) || isAutomatedBatchPrompt(raw)) return "";
  let text = raw;
  for (const pattern of INJECTED_BLOCKS) text = text.replace(pattern, " ");
  text = text.replace(/\s+/gu, " ").trim();
  if (text === "" || isCliControlTurn(text) || isAutomatedBatchPrompt(text)) return "";
  if (INJECTED_TURNS.some((pattern) => pattern.test(text))) return "";
  return clipUnits(text, TURN_CLIP);
}

function parseEvalCursor(
  raw: string | null,
): { day: string; pass: number; total: number; full: number; coding: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.day !== "string") return null;
    const number = (value: unknown) => (typeof value === "number" ? value : 0);
    return {
      day: parsed.day,
      pass: number(parsed.pass),
      total: number(parsed.total),
      full: number(parsed.full),
      coding: number(parsed.coding),
    };
  } catch {
    return null;
  }
}

function nextProbeNumber(probes: readonly TwinProbe[]): number {
  let max = 0;
  for (const probe of probes) {
    const match = /^p(\d+)$/u.exec(probe.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function byteSize(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

async function completeJson<T>(
  llm: LlmBackend,
  prompt: { system: string; user: string },
  jsonSchema: Record<string, unknown>,
  parse: (input: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  return completeJsonWithRetry(llm, prompt, jsonSchema, parse, {
    ...(signal === undefined ? {} : { signal }),
    wrapError: (detail) => new Error(`数字分身没有写完：${detail.split("\n")[0] ?? ""}`),
  });
}

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) return;
        results[index] = await run(item);
      }
    }),
  );
  return results;
}
