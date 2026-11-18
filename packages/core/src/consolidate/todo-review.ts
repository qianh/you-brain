import { extractJson } from "../refine/parse.js";
import { parseTodoReview } from "./normalize.js";
import { TODO_REVIEW_JSON_SCHEMA } from "./schema.js";
import { selectTopicsChangedOnDay } from "./select.js";
import type { ConsolidationContext, ConsolidationStep } from "./steps.js";

export const TODO_REVIEW_CURSOR = "consolidate.todo_review";
export const TODO_REVIEW_TRANSCRIPT_CHARS = 24_000;
const MAX_ATTEMPTS = 2;
const TOPIC_CONCURRENCY = 2;
const MIN_QUOTE_CHARS = 6;

export const TODO_REVIEW_SYSTEM_PROMPT = `你是 you-brain 的夜间待办核对器。对照一个话题当天的会话原文，逐条检查现有的开放待办是否已经完成或作废。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. 默认保留：原文没有明确提到，或只是部分推进、尚未最终做完的待办，一律输出 verdict = "keep"，quote 输出空字符串。
2. verdict = "done"：当天会话原文明确表明这件事已经做完、已验证或已上线。
3. verdict = "dropped"：当天会话原文明确表明这件事取消不做、方案已废弃，或是当时会话内的一次性临时动作（如临时看一眼日志、删临时目录）且已过时。
4. 判 "done" 或 "dropped" 时，quote 必须逐字摘录输入原文里直接证明该结论的一句连续原话（不少于 6 个字，不得改写或拼接）。找不到原句依据就输出 "keep"。
5. JSON 键名保持英文。`;

export interface TodoReviewRecord {
  todoId: string;
  topicId: string;
  status: "done" | "dropped";
  quote: string;
}

export function quoteAppearsInTranscript(quote: string, transcript: string): boolean {
  const normalizedQuote = normalizeSpaces(quote);
  if (Array.from(normalizedQuote).length < MIN_QUOTE_CHARS) return false;
  const normalizedTranscript = normalizeSpaces(transcript);
  return normalizedTranscript.includes(normalizedQuote);
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function fitTranscriptTail(raw: string, maxChars = TODO_REVIEW_TRANSCRIPT_CHARS): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const chars = Array.from(trimmed);
  if (chars.length <= maxChars) return trimmed;
  return chars.slice(-maxChars).join("");
}

export function buildTodoReviewPrompt(input: {
  day: string;
  topicName: string;
  todos: readonly { todoId: string; text: string }[];
  transcript: string;
}): { system: string; user: string } {
  const todos = input.todos
    .map((todo) => `- todoId: ${todo.todoId} · ${todo.text.replace(/[\r\n]+/gu, " ").trim()}`)
    .join("\n");
  const user = [
    `日期：${input.day}`,
    `话题：${input.topicName}`,
    "",
    "## 待核对的开放待办",
    todos,
    "",
    "## 当天会话原文（末尾部分）",
    fitTranscriptTail(input.transcript),
    "",
    "## 输出 JSON schema",
    JSON.stringify(TODO_REVIEW_JSON_SCHEMA),
  ].join("\n");
  return { system: TODO_REVIEW_SYSTEM_PROMPT, user };
}

export const todoReviewStep: ConsolidationStep = {
  id: "todo_review",
  async run(ctx) {
    const readTranscripts = ctx.topicTranscripts;
    if (!readTranscripts) return;

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

    const candidates = changed.flatMap((item) => {
      const topicId = item.topic.topicId;
      const openTodos = loaded.book.todos.filter(
        (todo) => todo.topicId === topicId && todo.status === "open" && !todo.userLocked,
      );
      if (openTodos.length === 0) return [];
      const sessionKeys = loaded.book.sessions
        .filter((session) => session.topicId === topicId)
        .map((session) => session.sessionKey);
      if (sessionKeys.length === 0) return [];
      return [{ topicId, topicName: item.topic.name, openTodos, sessionKeys }];
    });

    if (candidates.length === 0) {
      ctx.cursors.set(TODO_REVIEW_CURSOR, JSON.stringify({ day: ctx.day, closed: [] }));
      return;
    }

    const outcomes = await mapWithLimit(candidates, TOPIC_CONCURRENCY, (candidate) =>
      reviewOneTopic(ctx, readTranscripts, candidate),
    );

    const closed: TodoReviewRecord[] = [];
    let failedCount = 0;
    let attemptedCount = 0;

    for (const outcome of outcomes) {
      if (!outcome.attempted) continue;
      attemptedCount += 1;
      if (outcome.failed) {
        failedCount += 1;
        ctx.warnings.push(`话题 ${outcome.topicId} 待办核对失败`);
        continue;
      }
      for (const item of outcome.closed) {
        await ctx.emit("todo.status_changed", {
          todoId: item.todoId,
          status: item.status,
          by: "auto",
        });
        closed.push(item);
      }
    }

    ctx.cursors.set(TODO_REVIEW_CURSOR, JSON.stringify({ day: ctx.day, closed }));
    if (attemptedCount > 0 && failedCount === attemptedCount) {
      throw new Error("待办核对全部失败");
    }
  },
};

async function reviewOneTopic(
  ctx: ConsolidationContext,
  readTranscripts: NonNullable<ConsolidationContext["topicTranscripts"]>,
  candidate: {
    topicId: string;
    topicName: string;
    openTodos: readonly { todoId: string; text: string }[];
    sessionKeys: readonly string[];
  },
): Promise<{
  topicId: string;
  attempted: boolean;
  failed: boolean;
  closed: TodoReviewRecord[];
}> {
  const transcript = fitTranscriptTail(
    await readTranscripts({ day: ctx.day, sessionKeys: candidate.sessionKeys }),
  );
  if (transcript === "") {
    return { topicId: candidate.topicId, attempted: false, failed: false, closed: [] };
  }

  const prompt = buildTodoReviewPrompt({
    day: ctx.day,
    topicName: candidate.topicName,
    todos: candidate.openTodos,
    transcript,
  });
  const openIds = new Set(candidate.openTodos.map((todo) => todo.todoId));

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
        jsonSchema: TODO_REVIEW_JSON_SCHEMA,
      });
      const parsed = parseTodoReview(extractJson(raw));
      const seen = new Set<string>();
      const closed: TodoReviewRecord[] = [];
      for (const item of parsed) {
        if (!openIds.has(item.todoId) || seen.has(item.todoId)) continue;
        seen.add(item.todoId);
        if (item.verdict === "keep") continue;
        if (!quoteAppearsInTranscript(item.quote, transcript)) continue;
        closed.push({
          todoId: item.todoId,
          topicId: candidate.topicId,
          status: item.verdict,
          quote: item.quote,
        });
      }
      return { topicId: candidate.topicId, attempted: true, failed: false, closed };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "模型输出无法校验";
      lastDetail = `${msg}\n${raw.trim().slice(0, 400)}`.trim();
    }
  }
  return { topicId: candidate.topicId, attempted: true, failed: true, closed: [] };
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
