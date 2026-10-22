import { ConflictError } from "../drive/errors.js";
import { extractJson } from "../refine/parse.js";
import type { SessionState, TopicBook } from "../topics/types.js";
import { parsePortraitUpdate } from "./normalize.js";
import { buildPortraitPrompt } from "./prompt.js";
import { PORTRAIT_JSON_SCHEMA } from "./schema.js";
import { instantOnLocalDay } from "./schedule.js";
import { selectTopicsChangedOnDay } from "./select.js";
import type { ConsolidationContext, ConsolidationStep } from "./steps.js";
import { textUnits } from "./text.js";

const MAX_ATTEMPTS = 2;

export const portraitStep: ConsolidationStep = {
  id: "portrait",
  dependsOn: ["topic_summaries"],
  async run(ctx) {
    const portrait = ctx.portrait;
    if (!portrait) return;
    const current = await portrait.read();
    if (!current) {
      ctx.warnings.push("没有现有数字分身，跳过");
      return;
    }
    const evidence = dayEvidence(ctx);
    const corrections = portrait.corrections();
    if (evidence.length === 0 && corrections.length === 0) return;
    const prompt = buildPortraitPrompt({
      day: ctx.day,
      current: current.text,
      topics: evidence,
      corrections,
    });
    let update: { changed: boolean; portrait: string } | null = null;
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
          jsonSchema: PORTRAIT_JSON_SCHEMA,
        });
        update = parsePortraitUpdate(extractJson(raw));
        break;
      } catch (error) {
        lastDetail = failureDetail(error, raw);
      }
    }
    if (!update) throw new Error("数字分身没有写完");
    if (!update.changed) return;
    const skip = rejectPortrait(current.text, update.portrait);
    if (skip) {
      ctx.warnings.push(skip);
      return;
    }
    let saved: { snapshot: string };
    try {
      saved = await portrait.save({
        text: update.portrait,
        previous: current.text,
        etag: current.etag,
        fileId: current.fileId,
        day: ctx.day,
      });
    } catch (error) {
      if (isConflict(error)) {
        ctx.warnings.push("数字分身在沉淀期间被别处更新，已跳过");
        return;
      }
      throw error;
    }
    const applied = new Set(prompt.includedCorrectionIds);
    for (const correction of corrections) {
      if (!applied.has(correction.correctionId)) continue;
      await ctx.emit("portrait.correction_applied", {
        correctionId: correction.correctionId,
        snapshot: saved.snapshot,
      });
    }
  },
};

function dayEvidence(ctx: ConsolidationContext): Array<{
  name: string;
  summary: string;
  titles: string[];
  conclusions: string[];
}> {
  const loaded = ctx.load();
  const changed = selectTopicsChangedOnDay({
    book: loaded.book,
    sessionUpdatedAt: loaded.sessionUpdatedAt,
    day: ctx.day,
    timeZone: ctx.timeZone,
    now: ctx.now().toISOString(),
    activeLimit: ctx.zone.activeLimit,
    historyDays: ctx.zone.historyDays,
  });
  return changed.map((item) => ({
    name: item.topic.name,
    summary: item.topic.summary,
    titles: sessionsTouchedOnDay(loaded.book, item.topic.topicId, loaded.sessionUpdatedAt, ctx).map(
      (session) => session.title,
    ),
    conclusions: loaded.book.conclusions
      .filter(
        (conclusion) =>
          conclusion.topicId === item.topic.topicId &&
          instantOnLocalDay(conclusion.ts, ctx.day, ctx.timeZone),
      )
      .map((conclusion) => conclusion.text),
  }));
}

function sessionsTouchedOnDay(
  book: TopicBook,
  topicId: string,
  sessionUpdatedAt: Readonly<Record<string, string>>,
  ctx: ConsolidationContext,
): SessionState[] {
  const touched = new Set<string>();
  for (const session of book.sessions) {
    if (session.topicId !== topicId) continue;
    const updated = sessionUpdatedAt[session.sessionKey];
    if (updated && instantOnLocalDay(updated, ctx.day, ctx.timeZone)) touched.add(session.sessionKey);
  }
  for (const event of book.memory.log) {
    if (!instantOnLocalDay(event.ts, ctx.day, ctx.timeZone)) continue;
    if (event.type === "session.refined" || event.type === "topic.assigned") {
      const session = book.sessions.find((item) => item.sessionKey === event.data.sessionKey);
      if (session?.topicId === topicId) touched.add(session.sessionKey);
    }
    if (
      (event.type === "conclusion.added" || event.type === "todo.added") &&
      event.data.topicId === topicId
    ) {
      touched.add(event.data.sessionKey);
    }
  }
  return book.sessions.filter((session) => touched.has(session.sessionKey) && session.title.trim() !== "");
}

/** Empty, too short, or unchanged output is kept off Drive. Returns the warning. */
function rejectPortrait(previous: string, next: string): string | null {
  if (next.replace(/\s+/gu, "") === "") return "数字分身输出为空，已跳过";
  if (textUnits(next) * 2 < textUnits(previous)) return "数字分身输出不到原来的一半，已跳过";
  if (next === previous) return "数字分身没有变化，已跳过";
  return null;
}

function isConflict(error: unknown): boolean {
  return error instanceof ConflictError;
}

function failureDetail(error: unknown, raw: string): string {
  const message = error instanceof Error ? error.message : "模型输出无法校验";
  const snippet = raw.trim().slice(0, 500);
  const text = snippet === "" ? message : `${message}\n上次输出：${snippet}`;
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}
