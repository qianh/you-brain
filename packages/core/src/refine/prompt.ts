import { REFINE_OUTPUT_JSON_SCHEMA } from "./schema.js";
import type { CandidateTopic, OpenTodo, PreviousRefine, RefineMessage } from "./types.js";

export const REFINE_SYSTEM_PROMPT = `你是 you-brain 的会话提炼器。根据「上次提炼结果」和「新增消息」，更新这一个会话的标题、概要、主话题、结论和待办。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. 优先归入已有话题。只有这段对话明显是一件新事情、和所有候选话题都对不上时，才新建话题（topic.action = "create"）。能归入就用 "assign"，并且 topicId 必须是候选话题给出的 topicId。
2. 一个会话只归入一个主话题。
3. 待办只输出有把握的事项，confidence 必须不低于 0.8。低于 0.8 的不要输出。
4. todos_completed 只能引用「开放待办」里给出的 todoId，不要编造 id。没有完成的就输出空数组。
5. conclusions_added 只写这次新增消息里新确定的结论，不要重复已有结论。
6. title 和 summary 用中文，短而具体。JSON 键名保持英文，不要翻译。`;

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
  ].join("\n");
}

function previousBlock(previous: PreviousRefine | null): string {
  if (!previous) return "（首次提炼，没有上次结果）";
  const todos = previous.todos.map((todo) => todo.text);
  return [
    `标题：${previous.title}`,
    `概要：${previous.summary}`,
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
    "### 历史（最近）",
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
    previousBlock(view.previous),
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
