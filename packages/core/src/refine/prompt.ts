import { REFINE_OUTPUT_JSON_SCHEMA } from "./schema.js";
import type { CandidateTopic, OpenTodo, PreviousRefine, RefineMessage } from "./types.js";

export const REFINE_SYSTEM_PROMPT = `你是 you-brain 的会话提炼器。根据「上次提炼结果」和「新增消息」，更新这一个会话的标题、概要、主话题、结论和待办。只输出一个 JSON 对象，不要 Markdown，不要解释。

话题是跨会话、跨天持续的一件事或一个项目，不是这次对话的标题。title 才是这次对话的标题。

规则：
1. 优先归入已有话题。同一个项目、系统或事情，不管这次是在开发、审查、测试、修复还是复核，都是同一个话题。只有这段对话明显是一件新事情、和所有候选话题都对不上时，才新建话题（topic.action = "create"）。能归入就用 "assign"，并且 topicId 必须是候选话题给出的 topicId。候选话题里最相关的排在前面。
2. 新建话题时，name 写这件事本身，不写这次做了什么：用项目、系统或事物的名字，4 到 16 个字，不带审查、测试、修复、复核这类动作词，也不带这次的细节。比如写「支付网关」，不写「支付网关回调修复复核」。
3. 一次性的小问题（查命令、问概念、问常识）归入它所属领域的宽话题，比如「Git 用法」「Mac 开发环境」「健康问答」。没有就用领域名新建，不要拿具体问题当话题名。
4. 没有实际内容的会话不归入话题，输出 topic.action = "none"，topicId、name 为空字符串，aliases、conclusions_added、todos_added 为空数组。包括：连通性或探针测试（只要求回复 ok、回一句话、记住暗号再复述）、子代理握手、问你是谁、空会话。用户在测试、但讨论的是某个项目的具体问题时，不算这一类。
5. 一个会话只归入一个主话题。「上次提炼结果」给出了当前话题时，继续用这个话题。
6. 待办只输出有把握的事项，confidence 必须不低于 0.8。低于 0.8 的不要输出。
7. todos_completed 只能引用「开放待办」里给出的 todoId，不要编造 id。没有完成的就输出空数组。
8. conclusions_added 只写这次新增消息里新确定的结论，不要重复已有结论。
9. title 和 summary 用中文，短而具体。JSON 键名保持英文，不要翻译。`;

export interface RefinePromptView {
  previous: PreviousRefine | null;
  topics: readonly CandidateTopic[];
  openTodos: readonly OpenTodo[];
  messages: readonly RefineMessage[];
  truncated: boolean;
}

function bullet(lines: readonly string[]): string {
  if (lines.length === 0) return "（无）";
  return lines.map((line) => `- ${line}`).join("\n");
}

function topicBlock(topic: CandidateTopic): string {
  const aliases = topic.aliases.length === 0 ? "（无）" : topic.aliases.join("、");
  return [
    `- topicId: ${topic.topicId}`,
    `  名称：${topic.name}`,
    `  别名：${aliases}`,
    `  概要：${topic.summary}`,
    ...(topic.recentTitles && topic.recentTitles.length > 0
      ? [`  最近会话：${topic.recentTitles.join("、")}`]
      : []),
  ].join("\n");
}

function previousBlock(
  previous: PreviousRefine | null,
  topics: readonly CandidateTopic[],
): string {
  if (!previous) return "（首次提炼，没有上次结果）";
  const todos = previous.todos.map((todo) => todo.text);
  const current = topics.find((topic) => topic.topicId === previous.topicId);
  return [
    `标题：${previous.title}`,
    `概要：${previous.summary}`,
    ...(current ? [`当前话题：${current.name}（topicId: ${current.topicId}）`] : []),
    "已有结论：",
    bullet(previous.conclusions),
    "已有待办（只作上下文，完成待办请用下面的开放待办 id）：",
    bullet(todos),
  ].join("\n");
}

function topicsBlock(topics: readonly CandidateTopic[]): string {
  const active = topics.filter((topic) => topic.zone === "active");
  const history = topics.filter((topic) => topic.zone === "history");
  if (active.length === 0 && history.length === 0) {
    return "（没有候选话题。这是一件新事情，请新建一个话题。）";
  }
  return [
    "### 活跃",
    active.length === 0 ? "（无）" : active.map(topicBlock).join("\n"),
    "### 历史（相关与最近）",
    history.length === 0 ? "（无）" : history.map(topicBlock).join("\n"),
  ].join("\n");
}

export function buildRefinePrompt(view: RefinePromptView): { system: string; user: string } {
  const messageText =
    view.messages.length === 0
      ? "（无）"
      : view.messages.map((message) => `[${message.role}]\n${message.text}`).join("\n\n");
  const truncation = view.truncated
    ? "（更早的新增消息已因长度截断，下面只保留最近的内容）\n"
    : "";
  const openTodos =
    view.openTodos.length === 0
      ? "（没有可完成的开放待办，todos_completed 必须是空数组）"
      : view.openTodos
          .map((todo) => `- todoId: ${todo.todoId} · topicId: ${todo.topicId} · ${todo.text}`)
          .join("\n");
  const user = [
    "## 上次提炼结果",
    previousBlock(view.previous, view.topics),
    "",
    "## 候选话题",
    "优先归入下面已有话题。一个会话只归入一个主话题。",
    topicsBlock(view.topics),
    "",
    "## 开放待办",
    "todos_completed 只能引用这里的 todoId。",
    openTodos,
    "",
    "## 新增消息",
    truncation + messageText,
    "",
    "## 输出 JSON schema",
    JSON.stringify(REFINE_OUTPUT_JSON_SCHEMA),
  ].join("\n");
  return { system: REFINE_SYSTEM_PROMPT, user };
}
