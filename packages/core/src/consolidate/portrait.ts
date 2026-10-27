import { ConflictError } from "../drive/errors.js";
import type { LlmBackend } from "../llm/types.js";
import { extractJson } from "../refine/parse.js";
import {
  parseTwinAnswers,
  parseTwinClaims,
  parseTwinEdits,
  parseTwinJudge,
  parseTwinProbes,
  type TwinClaim,
  type TwinEditsUpdate,
} from "./normalize.js";
import {
  buildTwinClaimsPrompt,
  buildTwinEvalAnswerPrompt,
  buildTwinEvalJudgePrompt,
  buildTwinFixPrompt,
  buildTwinMergePrompt,
  buildTwinProbesPrompt,
  type TwinPromptCorrection,
} from "./prompt.js";
import { shiftDateKey } from "./schedule.js";
import {
  TWIN_CLAIMS_JSON_SCHEMA,
  TWIN_EDITS_JSON_SCHEMA,
  TWIN_EVAL_ANSWERS_JSON_SCHEMA,
  TWIN_EVAL_JUDGE_JSON_SCHEMA,
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
  applyTwinEdits,
  bumpVersion,
  changedLayers,
  checkTwin,
  skeletonTwin,
  splitTwin,
  twinBody,
  twinVersion,
  withCodingIndex,
  withHeader,
  type TwinLayer,
  type TwinTexts,
  type VersionBump,
} from "./twin.js";

const MAX_ATTEMPTS = 2;
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

export const PORTRAIT_TURNS_CURSOR = "portrait.turns";
export const PORTRAIT_EVAL_CURSOR = "portrait.eval";

export const portraitStep: ConsolidationStep = {
  id: "portrait",
  dependsOn: ["topic_summaries"],
  async run(ctx) {
    const portrait = ctx.portrait;
    if (!portrait) return;
    const files = await portrait.read();
    if (!files.full || !files.coding) {
      ctx.warnings.push("没有现有数字分身，跳过");
      return;
    }
    const before = textsOf(files);
    const seen = parseTurnCursor(ctx.cursors.get(PORTRAIT_TURNS_CURSOR));
    const input = collectTurns(await portrait.sessions(ctx.day), seen);
    const corrections = portrait.corrections();
    if (input.chunks.length === 0 && corrections.length === 0) return;

    const claims = (
      await extractClaims(ctx.llm, input.chunks, "sessions", projectNames(before.projects))
    ).map((claim) => ({ ...claim, day: ctx.day }));
    const earlier = (await portrait.pendingClaims()).filter((claim) => claim.day !== ctx.day);
    const low = claims.filter((claim) => claim.confidence === "low");
    const keepFrom = shiftDateKey(ctx.day, -PENDING_KEEP_DAYS);
    if (input.chunks.length > 0) {
      await portrait.saveClaims({
        name: ctx.day,
        claims,
        pending: [...earlier.filter((claim) => claim.day >= keepFrom), ...low],
      });
    }
    const high = claims.filter((claim) => claim.confidence === "high");
    if (high.length === 0 && corrections.length === 0 && (low.length === 0 || earlier.length === 0)) {
      ctx.cursors.set(PORTRAIT_TURNS_CURSOR, JSON.stringify(input.cursor));
      return;
    }

    const merged = await mergeOnce(ctx.llm, {
      day: ctx.day,
      docs: before,
      claims,
      pending: earlier,
      corrections,
    });
    const outcome = await finishTwin(ctx.llm, before, merged.texts, { guardShrink: true });
    if ("skip" in outcome) {
      ctx.warnings.push(outcome.skip);
      ctx.cursors.set(PORTRAIT_TURNS_CURSOR, JSON.stringify(input.cursor));
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
          return;
        }
        throw error;
      }
      for (const warning of outcome.warnings) ctx.warnings.push(warning);
    }
    ctx.cursors.set(PORTRAIT_TURNS_CURSOR, JSON.stringify(input.cursor));
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
    const files = await portrait.read();
    if (!files.full || !files.coding) return;

    let probes = await portrait.probes();
    const days = Array.from({ length: EVAL_INTERVAL_DAYS }, (_, index) => shiftDateKey(ctx.day, -index));
    const weekClaims = (await portrait.claimsOf(days)).filter(
      (claim) => claim.confidence === "high" && claim.layer !== "project",
    );
    if (weekClaims.length > 0) {
      const prompt = buildTwinProbesPrompt({ claims: weekClaims, existing: probes });
      const drafts = await completeJson(ctx.llm, prompt, TWIN_PROBES_JSON_SCHEMA, parseTwinProbes);
      if (drafts.length > 0) {
        let next = nextProbeNumber(probes);
        probes = [
          ...probes,
          ...drafts.map((draft) => ({ id: `p${String(next++).padStart(2, "0")}`, ...draft })),
        ];
        await portrait.saveProbes(probes);
      }
    }
    const sizes = { full: byteSize(files.full.text), coding: byteSize(files.coding.text) };
    if (probes.length === 0) {
      ctx.cursors.set(PORTRAIT_EVAL_CURSOR, JSON.stringify({ day: ctx.day, pass: 0, total: 0, ...sizes }));
      return;
    }
    const answers = await completeJson(
      ctx.llm,
      buildTwinEvalAnswerPrompt({ full: files.full.text, coding: files.coding.text, probes }),
      TWIN_EVAL_ANSWERS_JSON_SCHEMA,
      parseTwinAnswers,
    );
    const verdicts = await completeJson(
      ctx.llm,
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
    const failed = probes.filter((probe) => verdicts.get(probe.id) !== true).map((probe) => probe.id);
    const pass = probes.length - failed.length;
    const lines = [
      `## 评测 · ${ctx.day}`,
      `- 得分 ${pass}/${probes.length}`,
      `- 常驻层 full ${sizes.full} 字节，coding ${sizes.coding} 字节`,
    ];
    if (failed.length > 0) lines.push(`- 答错：${failed.join("、")}`);
    await portrait.appendChangelog(lines.join("\n"));
    ctx.cursors.set(PORTRAIT_EVAL_CURSOR, JSON.stringify({ day: ctx.day, pass, total: probes.length, ...sizes }));

    const notes: string[] = [];
    if (last && last.total > 0) {
      const before = last.pass / last.total;
      const now = pass / probes.length;
      if (now < before) notes.push(`保真评测得分从 ${last.pass}/${last.total} 降到 ${pass}/${probes.length}`);
      const grew = sizes.full + sizes.coding > last.full + last.coding;
      if (grew && now <= before) notes.push("常驻层变长了，评测得分没有上升");
    }
    if (notes.length > 0) {
      await ctx.emit("reminder.issued", {
        reminderId: `portrait-eval-${ctx.day}`,
        kind: "portrait_eval",
        topicId: null,
        text: `${notes.join("；")}。答错的题：${failed.join("、") || "无"}`,
      });
    }
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

async function fixOnce(llm: LlmBackend, texts: TwinTexts, problems: readonly string[]): Promise<TwinTexts> {
  const update: TwinEditsUpdate = await completeJson(
    llm,
    buildTwinFixPrompt({ docs: texts, problems }),
    TWIN_EDITS_JSON_SCHEMA,
    parseTwinEdits,
  );
  return withIndex(applyTwinEdits(texts, update.edits));
}

function withIndex(texts: TwinTexts): TwinTexts {
  return { ...texts, coding: withCodingIndex(texts.coding, texts.projects) };
}

type FinishOutcome =
  | { skip: string }
  | {
      texts: TwinTexts;
      changed: Set<TwinLayer>;
      warnings: string[];
      sizes: { full: number; coding: number; maxSection: number };
    };

/** Checks before writing, with one fix pass. Unchanged layers come back byte for byte. */
async function finishTwin(
  llm: LlmBackend,
  before: TwinTexts,
  merged: TwinTexts,
  options: { guardShrink: boolean },
): Promise<FinishOutcome> {
  let texts = merged;
  let changed = changedLayers(before, texts);
  if (changed.size === 0) return { texts: before, changed, warnings: [], sizes: checkTwin(before, changed).sizes };
  let check = checkTwin(texts, changed);
  if (check.blocking.length > 0 || check.warnings.length > 0) {
    texts = await fixOnce(llm, texts, [...check.blocking, ...check.warnings]);
    changed = changedLayers(before, texts);
    check = checkTwin(texts, changed);
  }
  if (check.blocking.length > 0) return { skip: `数字分身没有通过写入前检查，已跳过：${check.blocking.join("；")}` };
  if (check.scanHits.length > 0) {
    return { skip: `数字分身里发现疑似敏感信息，已跳过：${check.scanHits.join("、")}` };
  }
  if (options.guardShrink) {
    for (const layer of changed) {
      const previous = twinBody(before[layer]);
      if (previous !== "" && textUnits(twinBody(texts[layer])) * 2 < textUnits(previous)) {
        return { skip: `数字分身 ${layer} 输出不到原来的一半，已跳过` };
      }
    }
  }
  const kept = { ...texts };
  for (const layer of TWIN_LAYERS) if (!changed.has(layer)) kept[layer] = before[layer];
  return { texts: kept, changed, warnings: check.warnings, sizes: check.sizes };
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

/** Body without the version line and the generated project index. */
function substantive(text: string): string {
  return twinBody(withCodingIndex(text, ""));
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
): Promise<TwinClaim[]> {
  let done = 0;
  const results = await mapWithLimit(chunks, EXTRACT_CONCURRENCY, async (text) => {
    const claims = await completeJson(
      llm,
      buildTwinClaimsPrompt({ source, projects, text }),
      TWIN_CLAIMS_JSON_SCHEMA,
      parseTwinClaims,
    );
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

type TurnCursor = Record<string, number>;

function parseTurnCursor(raw: string | null): TurnCursor {
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

/**
 * New user turns per session past the cursor, packed into extraction chunks.
 * Turns over the day's cap stay behind the cursor for the next run.
 */
function collectTurns(
  sessions: ReadonlyArray<{ sessionKey: string; title: string; turns: readonly string[] }>,
  seen: TurnCursor,
): { chunks: string[]; cursor: TurnCursor } {
  const cursor: TurnCursor = { ...seen };
  const pieces: string[] = [];
  let used = 0;
  for (const session of sessions) {
    const start = Math.min(seen[session.sessionKey] ?? 0, session.turns.length);
    const lines: string[] = [];
    let taken = start;
    for (let index = start; index < session.turns.length; index += 1) {
      const text = cleanUserTurn(session.turns[index] ?? "");
      const size = textUnits(text) + 2;
      if (text !== "" && used + size > DAY_UNITS) break;
      if (text !== "") {
        lines.push(`- ${text}`);
        used += size;
      }
      taken = index + 1;
    }
    cursor[session.sessionKey] = taken;
    if (lines.length > 0) pieces.push([`### ${session.title.trim() || "（无标题）"}`, ...lines].join("\n"));
    if (used >= DAY_UNITS) break;
  }
  return { chunks: packPieces(pieces.flatMap((piece) => (textUnits(piece) <= CHUNK_UNITS ? [piece] : splitLines(piece)))), cursor };
}

const INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gu,
  /<(command|local-command)-[a-z-]+>[\s\S]*?<\/(command|local-command)-[a-z-]+>/gu,
  /<task-notification>[\s\S]*?<\/task-notification>/gu,
];
const INJECTED_TURNS = [/^This session is being continued/u, /^Caveat: /u];

/** The user's own words: injected context blocks and harness turns drop out. */
export function cleanUserTurn(raw: string): string {
  let text = raw;
  for (const pattern of INJECTED_BLOCKS) text = text.replace(pattern, " ");
  text = text.replace(/\s+/gu, " ").trim();
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
): Promise<T> {
  let lastDetail = "模型输出无法校验";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const user =
      attempt === 1
        ? prompt.user
        : `${prompt.user}\n\n## 上次输出无法通过校验\n${lastDetail}\n请只输出修正后的 JSON。`;
    let raw = "";
    try {
      raw = await llm.complete({ system: prompt.system, user, jsonSchema });
      return parse(extractJson(raw));
    } catch (error) {
      lastDetail = failureDetail(error, raw);
    }
  }
  throw new Error(`数字分身没有写完：${lastDetail.split("\n")[0] ?? ""}`);
}

function failureDetail(error: unknown, raw: string): string {
  const message = error instanceof Error ? error.message : "模型输出无法校验";
  const snippet = raw.trim().slice(0, 500);
  const text = snippet === "" ? message : `${message}\n上次输出：${snippet}`;
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
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
