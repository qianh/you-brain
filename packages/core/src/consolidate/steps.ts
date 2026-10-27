import type { EventOf, EventType } from "@you-brain/protocol";

import type { LlmBackend } from "../llm/types.js";
import { extractJson } from "../refine/parse.js";
import type { TopicBook } from "../topics/types.js";
import { partitionTopics } from "../topics/zones.js";
import { normalizeMergePairs, parseTopicRewrite } from "./normalize.js";
import { buildMergeSuggestionsPrompt, buildTopicSummaryPrompt } from "./prompt.js";
import { instantOnLocalDay } from "./schedule.js";
import { MERGE_SUGGESTIONS_JSON_SCHEMA, TOPIC_SUMMARY_JSON_SCHEMA } from "./schema.js";
import {
  recentTopicSessions,
  selectChangedTopics,
  selectMergeCandidates,
} from "./select.js";
import type { TopicFilesResult } from "../topic-files/sync.js";
import { MERGE_SUGGESTIONS_CURSOR } from "./suggestions.js";
import type { TwinClaim } from "./normalize.js";
import { portraitEvalStep, portraitMonthlyStep, portraitStep } from "./portrait.js";
import { sameText } from "./text.js";
import type { TwinLayer } from "./twin.js";

export { portraitEvalStep, portraitMonthlyStep, portraitStep };

const MAX_ATTEMPTS = 2;
const TOPIC_CONCURRENCY = 2;

export interface TwinFileRef {
  text: string;
  etag: string;
  fileId: string;
}

export interface StoredTwinClaim extends TwinClaim {
  day: string;
}

export interface TwinProbe {
  id: string;
  layer: "persona" | "coding";
  situation: string;
  expect: string;
}

/** One dated snapshot of the full layer, parsed from the snapshot file name. */
export interface TwinSnapshotRef {
  /** Bare file name inside the snapshot directory, no separators. */
  file: string;
  version: string;
  day: string;
}

export interface ConsolidationPortrait {
  /** Current files of the three layers. A missing file is null. */
  read(): Promise<Record<TwinLayer, TwinFileRef | null>>;
  /** The user's own turns, in order, for sessions updated on or after `day`. */
  sessions(day: string): Promise<Array<{ sessionKey: string; title: string; turns: string[] }>>;
  /** Pending corrections for any layer, oldest first. */
  corrections(): Array<{ correctionId: string; variant: string; section: string; text: string }>;
  /** Low-confidence claims kept from earlier days. */
  pendingClaims(): Promise<StoredTwinClaim[]>;
  /** Write `claims/<name>.jsonl`; a non-null `pending` replaces `claims/pending.jsonl`. */
  saveClaims(input: {
    name: string;
    claims: readonly StoredTwinClaim[];
    pending: readonly StoredTwinClaim[] | null;
  }): Promise<void>;
  /** Claims saved for these days. Missing days are skipped. */
  claimsOf(days: readonly string[]): Promise<StoredTwinClaim[]>;
  /**
   * Back up each previous file, update it with ifMatch (or create it), write the full
   * snapshot when full changed, prepend the changelog entry, then refresh the local cache.
   */
  save(input: {
    day: string;
    version: string;
    files: Array<{ layer: TwinLayer; text: string; previous: TwinFileRef | null }>;
    changelog: string;
  }): Promise<{ snapshot: string | null; links: Partial<Record<TwinLayer, string>> }>;
  probes(): Promise<TwinProbe[]>;
  saveProbes(probes: readonly TwinProbe[]): Promise<void>;
  /** Prepend an entry to the changelog. */
  appendChangelog(entry: string): Promise<void>;
  /** full snapshots written on change, oldest first. Absent where listing is unavailable. */
  snapshots?(): Promise<TwinSnapshotRef[]>;
  /** Read one snapshot by its bare file name. */
  readSnapshot?(file: string): Promise<string | null>;
}

export interface ConsolidationContext {
  day: string;
  timeZone: string;
  now: () => Date;
  load: () => {
    book: TopicBook;
    sessionUpdatedAt: Readonly<Record<string, string>>;
  };
  zone: { activeLimit: number; historyDays: number };
  llm: LlmBackend;
  warnings: string[];
  emit: <T extends EventType>(type: T, data: EventOf<T>["data"]) => Promise<void>;
  cursors: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
  /** Absent when Drive or the portrait service is not open. The step then succeeds. */
  portrait?: ConsolidationPortrait;
  /**
   * Absent when this device should not publish topic files.
   * The step then succeeds without writing.
   */
  topicFiles?: () => Promise<TopicFilesResult>;
}

export interface ConsolidationStep {
  id: string;
  /** Skipped when any listed step failed. */
  dependsOn?: readonly string[];
  run(ctx: ConsolidationContext): Promise<void>;
}

/** Steps registered by tests. Built-in steps stay in {@link consolidationSteps}. */
const registeredSteps: ConsolidationStep[] = [];

export function registerConsolidationStep(step: ConsolidationStep): void {
  if (registeredSteps.some((item) => item.id === step.id)) return;
  registeredSteps.push(step);
}

export function resetConsolidationSteps(): void {
  registeredSteps.length = 0;
}

export function consolidationSteps(): ConsolidationStep[] {
  return [
    topicSummariesStep,
    mergeSuggestionsStep,
    portraitStep,
    portraitEvalStep,
    portraitMonthlyStep,
    topicFilesStep,
    ...registeredSteps,
  ];
}

export const topicSummariesStep: ConsolidationStep = {
  id: "topic_summaries",
  async run(ctx) {
    const loaded = ctx.load();
    const changed = selectChangedTopics({
      book: loaded.book,
      sessionUpdatedAt: loaded.sessionUpdatedAt,
      day: ctx.day,
      timeZone: ctx.timeZone,
      now: ctx.now().toISOString(),
      activeLimit: ctx.zone.activeLimit,
      historyDays: ctx.zone.historyDays,
    });
    const outcomes = await mapWithLimit(changed, TOPIC_CONCURRENCY, (item) =>
      rewriteTopic(ctx, loaded, item.topic.topicId),
    );
    let failed = 0;
    for (const outcome of outcomes) {
      if (outcome.rewrite) {
        await ctx.emit("topic.summary_rewritten", {
          topicId: outcome.topicId,
          summary: outcome.rewrite.summary,
          nextStep: outcome.rewrite.nextStep,
        });
      }
      if (outcome.failed) {
        failed += 1;
        ctx.warnings.push(`话题 ${outcome.topicId} 概要重写失败`);
      }
    }
    if (failed > 0) throw new Error("部分话题概要没有写完");
  },
};

export const topicFilesStep: ConsolidationStep = {
  id: "topic_files",
  dependsOn: ["topic_summaries"],
  async run(ctx) {
    const write = ctx.topicFiles;
    if (!write) return;
    const result = await write();
    for (const warning of result.warnings) ctx.warnings.push(warning);
    if (result.failed > 0) {
      const summary = `话题文件有 ${result.failed} 个没有写上`;
      if (!ctx.warnings.includes(summary)) ctx.warnings.push(summary);
      throw new Error("部分话题文件没有写完");
    }
  },
};

export const mergeSuggestionsStep: ConsolidationStep = {
  id: "merge_suggestions",
  async run(ctx) {
    const loaded = ctx.load();
    const zoned = partitionTopics(loaded.book, {
      now: ctx.now().toISOString(),
      activeLimit: ctx.zone.activeLimit,
      historyDays: ctx.zone.historyDays,
      sessionUpdatedAt: loaded.sessionUpdatedAt,
    });
    const candidates = selectMergeCandidates([...zoned.active, ...zoned.history]);
    if (candidates.length < 2) {
      ctx.cursors.set(MERGE_SUGGESTIONS_CURSOR, JSON.stringify({ day: ctx.day, pairs: [] }));
      return;
    }
    const allowed = new Set(candidates.map((topic) => topic.topicId));
    const prompt = buildMergeSuggestionsPrompt({
      day: ctx.day,
      topics: candidates.map((topic) => ({
        topicId: topic.topicId,
        name: topic.name,
        aliases: topic.aliases,
        summary: topic.summary,
        zone: topic.zone,
      })),
    });
    let lastDetail = "模型输出无法校验";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const user =
        attempt === 1
          ? prompt.user
          : `${prompt.user}\n\n## 上次输出无法通过校验\n${lastDetail}\n请只输出修正后的 JSON。`;
      let raw = "";
      try {
        raw = await ctx.llm.complete({
          system: prompt.system,
          user,
          jsonSchema: MERGE_SUGGESTIONS_JSON_SCHEMA,
        });
        const pairs = normalizeMergePairs(extractJson(raw), allowed);
        ctx.cursors.set(MERGE_SUGGESTIONS_CURSOR, JSON.stringify({ day: ctx.day, pairs }));
        return;
      } catch (error) {
        lastDetail = failureDetail(error, raw);
      }
    }
    throw new Error("合并建议没有写完");
  },
};

interface RewriteOutcome {
  topicId: string;
  rewrite: { summary: string; nextStep: string } | null;
  failed: boolean;
}

async function rewriteTopic(
  ctx: ConsolidationContext,
  loaded: ReturnType<ConsolidationContext["load"]>,
  topicId: string,
): Promise<RewriteOutcome> {
  const topic = loaded.book.topics.find((item) => item.topicId === topicId);
  if (!topic || topic.userLocked || topic.mergedInto !== null) {
    return { topicId, rewrite: null, failed: false };
  }
  const sessions = recentTopicSessions({
    book: loaded.book,
    topicId,
    sessionUpdatedAt: loaded.sessionUpdatedAt,
    day: ctx.day,
    timeZone: ctx.timeZone,
  });
  const sessionIds = new Set(sessions.map((session) => session.sessionKey));
  const conclusionsBySession = new Map<string, string[]>();
  for (const conclusion of loaded.book.conclusions) {
    if (conclusion.topicId !== topicId || !sessionIds.has(conclusion.sessionKey)) continue;
    if (!instantOnLocalDay(conclusion.ts, ctx.day, ctx.timeZone)) continue;
    const list = conclusionsBySession.get(conclusion.sessionKey) ?? [];
    list.push(conclusion.text);
    conclusionsBySession.set(conclusion.sessionKey, list);
  }
  const prompt = buildTopicSummaryPrompt({
    day: ctx.day,
    name: topic.name,
    aliases: topic.aliases,
    summary: topic.summary,
    nextStep: topic.nextStep,
    sessions: sessions.map((session) => ({
      title: session.title,
      summary: session.summary,
      conclusions: conclusionsBySession.get(session.sessionKey) ?? [],
    })),
    openTodos: loaded.book.todos
      .filter((todo) => todo.topicId === topicId && todo.status === "open")
      .map((todo) => todo.text),
  });
  let lastDetail = "模型输出无法校验";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const user =
      attempt === 1
        ? prompt.user
        : `${prompt.user}\n\n## 上次输出无法通过校验\n${lastDetail}\n请只输出修正后的 JSON。`;
    let raw = "";
    try {
      raw = await ctx.llm.complete({
        system: prompt.system,
        user,
        jsonSchema: TOPIC_SUMMARY_JSON_SCHEMA,
      });
      const rewrite = parseTopicRewrite(extractJson(raw));
      if (sameText(rewrite.summary, topic.summary) && sameText(rewrite.nextStep, topic.nextStep)) {
        return { topicId, rewrite: null, failed: false };
      }
      return { topicId, rewrite, failed: false };
    } catch (error) {
      lastDetail = failureDetail(error, raw);
    }
  }
  return { topicId, rewrite: null, failed: true };
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
  if (items.length === 0) return results;
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
