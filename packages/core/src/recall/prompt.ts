import { extractJson } from "../refine/parse.js";
import {
  RECALL_ITEM_CHARS,
  RECALL_TEXT_MAX,
  RECALL_USER_CHARS,
  type RecallDecision,
  type RecallMemory,
} from "./types.js";

export const RECALL_SYSTEM_PROMPT = `你是 you-brain 的记忆提醒器。用户正在和某个 AI 助手对话，下面是他最近的发言，以及他以前在同一个话题里留下的记忆。判断这些记忆里有没有一条，现在提一句会改变他眼下要做的事。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. 默认不说。大多数时候输出 {"say": false}。
2. 只有下面这类情况才说：有件没做完的事和他现在正在做的直接相关；他现在说的做法和以前定过的决定相反；他以前在同一个地方卡住过，记忆里有当时怎么过去的。
3. 他这次发言里已经提到的事不说。只是同属一个话题、和眼下的事没有直接关系的不说。
4. 要说时只挑一条，basisId 填那条记忆的 id，必须是输入里给出的 id。
5. grade 只有两个取值：important 表示不提会造成损失或返工，比如正要做的事和以前定过的决定相反，或者有个期限快到了；normal 表示提了有帮助，不提也没有损失。拿不准就填 normal。
6. text 是对他说的一句中文口语，不超过 60 字，不换行，写清是哪件事并带上那条记忆的日期（几月几日）。不写统计，不写「该话题还有 N 项待办」这类句子，不编造输入里没有的事实。
7. JSON 键名保持英文。`;

export const RECALL_JSON_SCHEMA = {
  type: "object",
  properties: {
    say: { type: "boolean" },
    grade: { type: "string", enum: ["important", "normal"] },
    text: { type: "string" },
    basisId: { type: "string" },
  },
  required: ["say"],
  additionalProperties: false,
};

function oneLine(value: string, max: number): string {
  const text = value.replace(/[\r\n]+/gu, " ").trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** Newest turns that fit the budget, back in time order. A single oversized turn keeps its tail. */
function fitUserTurns(turns: readonly string[]): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = (turns[index] ?? "").trim();
    if (turn === "") continue;
    const chars = Array.from(turn);
    const room = RECALL_USER_CHARS - used;
    if (room <= 0) break;
    if (chars.length <= room) {
      kept.push(turn);
      used += chars.length;
    } else {
      kept.push(chars.slice(-room).join(""));
      break;
    }
  }
  return kept.reverse();
}

export function buildRecallPrompt(input: {
  memory: RecallMemory;
  userTurns: readonly string[];
  today: string;
}): { system: string; user: string } {
  const { memory } = input;
  const items = memory.items
    .map((item) => `[${item.id}] ${item.day ?? "-"} ${oneLine(item.text, RECALL_ITEM_CHARS)}`)
    .join("\n");
  const turns = fitUserTurns(input.userTurns);
  const user = [
    `今天：${input.today}`,
    `话题：${oneLine(memory.name, RECALL_ITEM_CHARS)}`,
    `话题概要：${oneLine(memory.summary, RECALL_ITEM_CHARS) || "（无）"}`,
    `上次聊这个话题：${memory.lastActiveDay ?? "未知"}`,
    "",
    "## 记忆",
    items,
    "",
    "## 他最近的发言",
    turns.length === 0 ? "（无）" : turns.join("\n\n"),
    "",
    "## 输出 JSON schema",
    JSON.stringify(RECALL_JSON_SCHEMA),
  ].join("\n");
  return { system: RECALL_SYSTEM_PROMPT, user };
}

/**
 * Throws when the output cannot be used, so the caller retries; never trims a bad
 * answer into shape. A basis that is not one of the memory items means the model made
 * the claim up: that is a decision not to speak, not an error.
 */
export function parseRecallDecision(raw: string, memory: RecallMemory): RecallDecision {
  const value = extractJson(raw);
  if (typeof value !== "object" || value === null) throw new Error("模型输出不是对象");
  const body = value as Record<string, unknown>;
  if (typeof body.say !== "boolean") throw new Error("缺少 say");
  if (!body.say) return { say: false };
  if (body.grade !== "important" && body.grade !== "normal") throw new Error("grade 不合法");
  if (typeof body.text !== "string") throw new Error("缺少 text");
  const text = body.text.trim();
  if (text === "") throw new Error("text 为空");
  if (/[\r\n]/u.test(text)) throw new Error("text 含换行");
  if (Array.from(text).length > RECALL_TEXT_MAX) throw new Error("text 超过 60 字");
  if (typeof body.basisId !== "string" || body.basisId === "") throw new Error("缺少 basisId");
  if (!memory.items.some((item) => item.id === body.basisId)) return { say: false };
  return { say: true, grade: body.grade, text, basisId: body.basisId };
}
