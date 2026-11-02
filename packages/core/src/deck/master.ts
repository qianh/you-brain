import type { LlmBackend } from "../llm/types.js";
import { DECISION_JSON_SCHEMA, parseDecision, type DeckDecision } from "./decision.js";
import { deckSkillText } from "./skill-text.js";
import type { DeckTurn } from "./types.js";

const HISTORY_TURNS = 12;
const SECTION_CAP = 4_000;

/** 主控的执行者目录文本（skill 里的「可用执行者」一节）。 */
export function executorCatalogText(rows: readonly string[]): string {
  return rows.length > 0 ? rows.map((row) => `- ${row}`).join("\n") : "- （暂无可用执行者）";
}

/** 上下文包：每个小节独立截断，坏掉的小节由调用方跳过。 */
export function buildContextPack(sections: readonly { title: string; body: string }[]): string {
  const parts = sections
    .filter((section) => section.body.trim() !== "")
    .map(
      (section) =>
        `### ${section.title}\n${section.body.trim().slice(0, SECTION_CAP)}`,
    );
  return parts.length > 0 ? parts.join("\n\n") : "（暂无）";
}

export function buildDecisionUser(input: {
  contextPack: string;
  history: readonly DeckTurn[];
  message: string;
}): string {
  const history = input.history
    .slice(-HISTORY_TURNS)
    .map((turn) => {
      const role = turn.role === "user" ? "用户" : turn.role === "assistant" ? "主控" : "系统";
      return `${role}：${turn.text.slice(0, 1_500)}`;
    })
    .join("\n");
  return `## 现在掌握的信息

${input.contextPack}

## 最近对话

${history === "" ? "（无）" : history}

## 用户最新消息

${input.message}

请输出决策 JSON。`;
}

export function buildDecisionSystem(input: {
  executors: string;
  now: string;
  timeZone: string;
}): string {
  return deckSkillText(input);
}

/** 跑一次主控决策。模型没给出合法 JSON 时，整段文本按回答处理。 */
export async function runMasterDecision(options: {
  backend: LlmBackend;
  system: string;
  user: string;
}): Promise<DeckDecision> {
  const text = await options.backend.complete({
    system: options.system,
    user: options.user,
    jsonSchema: DECISION_JSON_SCHEMA,
  });
  const decision = parseDecision(text);
  if (decision !== null) return decision;
  const fallback = text.trim();
  if (fallback === "") {
    throw new Error("主控没有返回决策");
  }
  return { kind: "answer", text: fallback };
}
