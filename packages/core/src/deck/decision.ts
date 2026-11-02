import { z } from "zod";

import { EXECUTOR_KINDS, DeckScheduleSchema, ExecutorRefSchema } from "./types.js";

/**
 * 主控的一次决策：直接回答、当场派活、或登记成周期任务。
 * 决策失败（模型没给出合法 JSON）时整体按 answer 处理。
 */
export const DeckDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    text: z.string().min(1, "回答不能为空"),
  }),
  z.object({
    kind: z.literal("dispatch"),
    title: z.string().min(1, "任务标题不能为空").max(120),
    executor: ExecutorRefSchema,
    prompt: z.string().min(1, "派活的指令不能为空").max(20_000),
  }),
  z.object({
    kind: z.literal("schedule"),
    title: z.string().min(1, "任务标题不能为空").max(120),
    executor: ExecutorRefSchema,
    prompt: z.string().min(1, "任务指令不能为空").max(20_000),
    schedule: DeckScheduleSchema,
  }),
]);

export type DeckDecision = z.infer<typeof DeckDecisionSchema>;

/**
 * 给模型用的 JSON Schema。刻意扁平：claude 的 --json-schema 不支持顶层
 * oneOf/allOf/anyOf（API 400），所以联合结构交给应用层的
 * DeckDecisionSchema（zod）校验，这里只引导字段形状。
 */
export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: { enum: ["answer", "dispatch", "schedule"] },
    text: { type: "string", description: "kind=answer 时的回答正文" },
    title: { type: "string", description: "dispatch/schedule 的任务短名（≤20 字）" },
    executor: {
      type: "object",
      properties: {
        kind: { enum: [...EXECUTOR_KINDS] },
        id: { type: "string", description: "执行者 id，逐字来自 skill 列表" },
      },
      required: ["kind", "id"],
    },
    prompt: { type: "string", description: "dispatch/schedule 给执行者的自包含指令" },
    schedule: {
      type: "object",
      properties: {
        kind: { enum: ["daily", "interval"] },
        time: { type: "string", description: "daily 的本地时间 HH:MM" },
        minutes: { type: "integer", description: "interval 的间隔分钟数（≥5）" },
      },
      required: ["kind"],
    },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

export function parseDecision(raw: string): DeckDecision | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const candidate = extractJsonObject(trimmed) ?? trimmed;
  try {
    const value: unknown = JSON.parse(candidate);
    return DeckDecisionSchema.parse(value);
  } catch {
    return null;
  }
}

/** 取文本里第一个平衡的 JSON 对象（容忍前后叙述文字）。 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}
