import { parseRefineOutput } from "@you-brain/protocol";

import type { LlmBackend } from "../llm/types.js";
import { defaultRefineIds, refineToEvents } from "./events.js";
import { fitRefineMessages, selectCandidateTopics, selectOpenTodos } from "./messages.js";
import { normalizeRefineOutput } from "./normalize.js";
import { extractJson } from "./parse.js";
import { buildRefinePrompt } from "./prompt.js";
import { REFINE_OUTPUT_JSON_SCHEMA } from "./schema.js";
import type { RefineResult, RefineSessionInput, RefineSessionOptions } from "./types.js";

const MAX_ATTEMPTS = 2;

function failureDetail(error: unknown, raw: string): string {
  const message = error instanceof Error ? error.message : "模型输出无法校验";
  const snippet = raw.trim().slice(0, 500);
  const text = snippet === "" ? message : `${message}\n上次输出：${snippet}`;
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

export async function refineSession(
  backend: LlmBackend,
  input: RefineSessionInput,
  options: RefineSessionOptions,
): Promise<RefineResult> {
  if (!Number.isInteger(input.refinedUpTo) || input.refinedUpTo < 0) {
    throw new Error("refinedUpTo must be a non-negative integer");
  }
  if (input.messages.length === 0) {
    return {
      status: "skipped",
      reason: "no_new_messages",
      attempts: 0,
      detail: "没有新增消息",
    };
  }

  const topics = selectCandidateTopics(input.topics, options.historyLimit);
  const openTodos = selectOpenTodos(input.openTodos, topics);
  const fitted = fitRefineMessages(
    input.messages,
    options.charBudget,
  );
  const prompt = buildRefinePrompt({
    previous: input.previous,
    topics,
    openTodos,
    messages: fitted.messages,
    truncated: fitted.truncated,
  });
  const ids = options.ids ?? defaultRefineIds();
  let lastDetail = "模型输出无法校验";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const user =
      attempt === 1
        ? prompt.user
        : `${prompt.user}\n\n## 上次输出无法通过校验\n${lastDetail}\n请只输出修正后的 JSON。`;
    const raw = await backend.complete({
      system: prompt.system,
      user,
      jsonSchema: REFINE_OUTPUT_JSON_SCHEMA,
    });
    try {
      const parsed = parseRefineOutput(extractJson(raw));
      const output = normalizeRefineOutput(parsed, {
        topics,
        openTodos,
        previous: input.previous,
        ids,
      });
      const events = refineToEvents(input, output, options.eventFactory, ids);
      return { status: "refined", output, events };
    } catch (error) {
      lastDetail = failureDetail(error, raw);
    }
  }

  return {
    status: "skipped",
    reason: "invalid_output",
    attempts: MAX_ATTEMPTS,
    detail: lastDetail,
  };
}
