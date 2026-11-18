import { extractJson } from "../refine/parse.js";
import {
  RECALL_HISTORY_CHARS,
  RECALL_ITEM_CHARS,
  RECALL_TEXT_MAX,
  RECALL_USER_CHARS,
  type RecallDecision,
  type RecallDialogueTurn,
  type RecallHistoryItem,
  type RecallMemory,
  type RecallReplyItem,
} from "./types.js";

const INJECTED_BOILERPLATE_PATTERNS = [
  /# AGENTS\.md instructions[^\n]*\n+\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/giu,
  /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/giu,
  /<environment_context>[\s\S]*?<\/environment_context>/giu,
  /<permissions instructions>[\s\S]*?<\/permissions instructions>/giu,
  /<collaboration_mode>[\s\S]*?<\/collaboration_mode>/giu,
  /<system-reminder>[\s\S]*?<\/system-reminder>/giu,
];

/**
 * Strips CLI-injected instruction/context blocks (e.g. Codex AGENTS.md wrappers) from a turn
 * so topic matching and the recall prompt only see what the user or assistant actually said.
 */
export function stripRecallBoilerplate(text: string): string {
  let cleaned = text;
  for (const pattern of INJECTED_BOILERPLATE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  return cleaned.trim();
}

export const RECALL_SYSTEM_PROMPT = `你是 you-brain 的记忆提醒器。用户正在和某个 AI 助手对话，下面是他最近的发言、当前会话助手的回复、他以前在同一个话题里留下的记忆、近期进展事实、旧会话片段和他自己回复过的提醒。请严格核对这些材料里有没有一条**未过时、未重复、且对眼下这一步真正重要**的信息需要现在提一句。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. 宁缺毋滥，默认不说。大多数时候输出 {"say": false}。不是同属一个话题或有一条开放待办就要提醒。
2. 先核对是否已过时或刚做完（命中任意一条必须输出 {"say": false}）：
   - 对照「近期进展与后续结论」和「当前会话助手最近回复」，如果某条旧待办或旧决定后来已被完成、已打出新包/新提交、已被新方案替代，说明那条旧待办没及时关闭，属于已过时，绝不能再提。
   - 如果用户当前发言已经在推进同一动作（如正在重新打包、部署、核查同一个对象），或助手在当前会话里已经给出了处理结果，绝不能马后炮提醒「这件还没做完」（除非旧记忆里有一条他眼下正违背的前置约束或红线）。
   - 他这次发言里已经提到的事不说；他自己回复处理过的旧事不再提。
3. 再核对对当前会话的重要性（只有会实质改变他眼下动作时才说）：
   - 防踩坑/防返工（grade = "important"）：他正要做的事与之前定下的决定/红线相反、漏掉了必须先满足的前置条件（如先发接口再跑预检、严禁写生产库等），或有明确期限快到了，不提会造成损失或返工。
   - 直接可复用的关键线索（grade = "normal"）：他眼下正卡在某个具体问题或正在权衡方案，记忆或旧会话里有现成的解法、关键路径、配置口径或排雷结论，提一句能帮他少走弯路。
   - 单纯顺带留下的陈旧待办、细枝末节（如旧 UI 样式微调）、或只是同属一个大话题但与眼下这一步无直接因果关系的事项，一律输出 {"say": false}。
4. 要说时只挑一条，basisId 只能填「记忆」或「历史会话片段」里带方括号给出的 id（严禁引用「近期进展与后续结论」或当前会话内容）。
5. text 是对他说的一句自然中文口语，不超过 60 字，不换行，写清是哪件事并带上那条材料的日期（几月几日）。不写统计，不写「该话题还有 N 项待办」这类套话，不编造输入里没有的事实。
6. JSON 键名保持英文。`;

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

const MAX_RECENT_ASSISTANT_TURNS = 3;
const ASSISTANT_TURN_CHARS = 360;

export function buildRecallPrompt(input: {
  memory: RecallMemory;
  userTurns: readonly string[];
  today: string;
  history?: readonly RecallHistoryItem[];
  replies?: readonly RecallReplyItem[];
  dialogue?: readonly RecallDialogueTurn[];
}): { system: string; user: string } {
  const { memory } = input;
  const items = memory.items
    .map((item) => `[${item.id}] ${item.day ?? "-"} ${oneLine(item.text, RECALL_ITEM_CHARS)}`)
    .join("\n");
  const factLines = (memory.recentFacts ?? [])
    .map((fact) => `- ${fact.day ?? "-"} ${oneLine(fact.text, RECALL_ITEM_CHARS)}`)
    .join("\n");
  const replyLines = (input.replies ?? [])
    .map((reply) => `- ${reply.day ?? "-"} 他回复过：${oneLine(reply.text, RECALL_ITEM_CHARS)}`)
    .join("\n");
  const assistantLines = (input.dialogue ?? [])
    .filter((turn) => turn.role === "assistant" && turn.text.trim() !== "")
    .slice(-MAX_RECENT_ASSISTANT_TURNS)
    .map((turn) => `- ${oneLine(tail(turn.text, ASSISTANT_TURN_CHARS), ASSISTANT_TURN_CHARS)}`)
    .join("\n");
  const history = (input.history ?? [])
    .map((item) => {
      const head = `[${item.id}] ${item.day ?? "-"} 会话「${oneLine(item.title, RECALL_ITEM_CHARS)}」他说过：`;
      return `${head}\n${tail(item.text, RECALL_HISTORY_CHARS)}`;
    })
    .join("\n\n");
  const cleanedUserTurns = input.userTurns.map(stripRecallBoilerplate).filter((t) => t !== "");
  const turns = fitUserTurns(cleanedUserTurns);
  const user = [
    `今天：${input.today}`,
    `话题：${oneLine(memory.name, RECALL_ITEM_CHARS)}`,
    `话题概要：${oneLine(memory.summary, RECALL_ITEM_CHARS) || "（无）"}`,
    `上次聊这个话题：${memory.lastActiveDay ?? "未知"}`,
    "",
    "## 记忆",
    items,
    factLines === ""
      ? ""
      : "\n## 近期进展与后续结论（仅用于核对上面记忆是否已过时或已完成，不可作为 basisId 引用）\n" + factLines,
    replyLines === "" ? "" : "\n他最近对提醒的回复（已处理，不要再提）：\n" + replyLines,
    "",
    "## 历史会话片段",
    history === "" ? "（无）" : history,
    "",
    "## 他最近的发言",
    turns.length === 0 ? "（无）" : turns.join("\n\n"),
    assistantLines === ""
      ? ""
      : "\n## 当前会话助手最近回复（仅用于核对事情是否已在当前对话做完，不可引用）\n" + assistantLines,
    "",
    "## 输出 JSON schema",
    JSON.stringify(RECALL_JSON_SCHEMA),
  ].join("\n");
  return { system: RECALL_SYSTEM_PROMPT, user };
}

/** Keeps the tail: what was said last in an old session matters most now. */
function tail(value: string, max: number): string {
  const chars = Array.from(value.trim());
  return chars.length <= max ? chars.join("") : `…${chars.slice(-max).join("")}`;
}

/**
 * Throws when the output cannot be used, so the caller retries; never trims a bad
 * answer into shape. A basis that is neither a memory item nor a history excerpt
 * means the model made the claim up: that is a decision not to speak, not an error.
 */
export function parseRecallDecision(
  raw: string,
  memory: RecallMemory,
  history: readonly RecallHistoryItem[] = [],
): RecallDecision {
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
  if (
    !memory.items.some((item) => item.id === body.basisId) &&
    !history.some((item) => item.id === body.basisId)
  ) {
    return { say: false };
  }
  return { say: true, grade: body.grade, text, basisId: body.basisId };
}
