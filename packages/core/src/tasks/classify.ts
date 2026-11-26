import type { LlmBackend } from "../llm/types.js";

/** TODO 任务类型前置分类结果，用于在启动 T3 会话前决定是否按 Provider 原生触发 `grill-me`。 */
export type TaskRequirementKind = "requirement" | "other" | "uncertain";

export type TaskRequirementClassifier = (input: {
  title: string;
  description: string;
  hasImages: boolean;
  projectContext?: string | null;
}) => Promise<TaskRequirementKind>;

export const CLASSIFY_TIMEOUT_MS = 12_000;
const PROJECT_CONTEXT_MAX_CHARS = 1_500;

export const TASK_CLASSIFY_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["requirement", "other", "uncertain"],
    },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

const CLASSIFY_SYSTEM = [
  "你是 U-Brain 开发 TODO 的前置分类器。在把 TODO 交给 T3 会话前，根据任务标题、任务说明、是否有图片附件以及项目背景，判断它属于哪一类：",
  '- "requirement"：需求型任务。包括新增功能、扩展产品能力、调整既有产品行为、交互、界面、业务规则或流程设计，或方案未定需要与用户讨论确认需求与关键取舍。',
  '- "other"：非需求型任务。包括仅恢复预期行为的缺陷修复（bugfix）、纯重构、补充或修复测试、文档/配置/依赖维护、问题排查、运维脚本等不改变产品需求定义的任务。',
  '- "uncertain"：无法确定。信息过少、语义歧义明显、既像修问题又像改需求，或附带图片且关键需求可能只在图片中导致仅凭文字无法确定。',
  "判断要求：",
  "- 结合完整语义判断，不要仅凭单个关键词机械归类。",
  "- 拿不准时务必输出 \"uncertain\"，由后续只读阶段再结合代码与图片向用户核实。",
  '只输出一行 JSON：{"kind":"requirement"}、{"kind":"other"} 或 {"kind":"uncertain"}，不要任何额外解释。',
].join("\n");

export function buildTaskClassifyUser(input: {
  title: string;
  description: string;
  hasImages: boolean;
  projectContext?: string | null;
}): string {
  const description = input.description.trim();
  const context = (input.projectContext ?? "").trim();
  const clippedContext =
    context.length > PROJECT_CONTEXT_MAX_CHARS
      ? `${context.slice(0, PROJECT_CONTEXT_MAX_CHARS)}…`
      : context;
  return [
    `任务标题：${input.title.trim()}`,
    `任务说明：${description === "" ? "（无）" : description}`,
    `是否附带图片附件：${input.hasImages ? "是（此处无法读取图片内容，若关键信息在图中请判 uncertain）" : "否"}`,
    ...(clippedContext === "" ? [] : [`项目既有口径参考：\n${clippedContext}`]),
  ].join("\n\n");
}

/** 解析分类器输出的 JSON；格式不合法或字段值不在枚举内时一律返回 "uncertain"。 */
export function parseTaskRequirementKind(raw: string): TaskRequirementKind {
  const match = /\{[^{}]*\}/u.exec(raw);
  if (!match) return "uncertain";
  try {
    const kind = (JSON.parse(match[0]) as { kind?: unknown }).kind;
    if (kind === "requirement" || kind === "other" || kind === "uncertain") {
      return kind;
    }
  } catch {
    // 非法 JSON 统一回退 uncertain。
  }
  return "uncertain";
}

/** 用 daemon 配置的 LLM 做前置类型判断；无可用模型、超时或出错时回退 "uncertain"，不阻断 TODO 启动。 */
export function createLlmTaskClassifier(
  getBackend: () => Promise<Pick<LlmBackend, "complete"> | null>,
  timeoutMs = CLASSIFY_TIMEOUT_MS,
): TaskRequirementClassifier {
  return async (input) => {
    try {
      const backend = await getBackend();
      if (!backend) return "uncertain";
      const raw = await backend.complete({
        system: CLASSIFY_SYSTEM,
        user: buildTaskClassifyUser(input),
        jsonSchema: TASK_CLASSIFY_JSON_SCHEMA,
        timeoutMs,
      });
      return parseTaskRequirementKind(raw);
    } catch (error) {
      console.error(`[tasks] 任务类型前置判断出错：${error instanceof Error ? error.message : String(error)}`);
      return "uncertain";
    }
  };
}
