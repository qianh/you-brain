import { parseRefineOutput, type RefineOutput, type RefineTopic } from "@you-brain/protocol";

import { canonicalTopicName, topicStem } from "../topics/normalize.js";
import type { CandidateTopic, OpenTodo, PreviousRefine, RefineIdSource } from "./types.js";

export const MIN_TODO_CONFIDENCE = 0.8;
const UNNAMED_TOPIC = "未命名话题";
const NO_TOPIC: RefineTopic = { action: "none", topicId: "", name: "", aliases: [] };

export function normalizeTopicName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function normalizeConclusion(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** Ignores case, width, spacing and punctuation, which the model varies between rounds. */
export function normalizeTodoText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function cleanAliases(aliases: readonly string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const alias of aliases) {
    const text = alias.trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    cleaned.push(text);
  }
  return cleaned;
}

function assignOf(topic: CandidateTopic): RefineTopic {
  return {
    action: "assign",
    topicId: topic.topicId,
    name: topic.name,
    aliases: cleanAliases(topic.aliases),
  };
}

export interface NormalizeContext {
  /** Every live topic, not just those offered to the model: duplicates are checked against all of them. */
  topics: readonly CandidateTopic[];
  openTodos: readonly OpenTodo[];
  previous: PreviousRefine | null;
  ids: Pick<RefineIdSource, "topicId">;
}

/**
 * A session that already has a topic keeps it: a later batch of messages sees only part
 * of the conversation, and the user may have moved the session there by hand.
 * none drops what would have hung off a topic, conclusions and todos.
 * create whose name matches any existing topic, or differs only by a verb, becomes assign.
 * assign of an unknown topicId becomes create, unless the name matches.
 * Todos under 0.8 and conclusions already stored are dropped.
 * todos_completed may only cite the given open todo ids.
 */
export function normalizeRefineOutput(
  output: RefineOutput,
  context: NormalizeContext,
): RefineOutput {
  const byId = new Map(context.topics.map((topic) => [topic.topicId, topic]));
  const byName = new Map<string, CandidateTopic>();
  const byStem = new Map<string, CandidateTopic>();
  for (const topic of context.topics) {
    const key = nameKey(topic.name);
    if (key !== "" && !byName.has(key)) byName.set(key, topic);
    const stem = topicStem(topic.name);
    if (stem !== null && !byStem.has(stem)) byStem.set(stem, topic);
  }

  const current = context.previous?.topicId ? byId.get(context.previous.topicId) : undefined;
  let topic: RefineTopic;
  if (current) {
    topic = assignOf(current);
  } else if (output.topic.action === "none") {
    topic = NO_TOPIC;
  } else if (output.topic.action === "assign") {
    const existing = byId.get(output.topic.topicId);
    topic = existing
      ? assignOf(existing)
      : createOrMatch(output.topic, output.title, byName, byStem, context.ids);
  } else {
    topic = createOrMatch(output.topic, output.title, byName, byStem, context.ids);
  }
  const hasTopic = topic.action !== "none";

  const seenConclusions = new Set(
    (context.previous?.conclusions ?? []).map((item) => normalizeConclusion(item)),
  );
  const conclusions: string[] = [];
  for (const item of hasTopic ? output.conclusions_added : []) {
    const text = item.trim();
    const key = normalizeConclusion(text);
    if (key === "" || seenConclusions.has(key)) continue;
    seenConclusions.add(key);
    conclusions.push(text);
  }

  // Same wording as an open todo of the target topic, an earlier todo of this session,
  // or another todo in this batch is the same todo: adding it again only inflates the count.
  const seenTodoTexts = new Set<string>([
    ...context.openTodos
      .filter((todo) => todo.topicId === topic.topicId)
      .map((todo) => normalizeTodoText(todo.text)),
    ...(context.previous?.todos ?? []).map((todo) => normalizeTodoText(todo.text)),
  ]);
  const todos: { text: string; confidence: number }[] = [];
  for (const todo of hasTopic ? output.todos_added : []) {
    const text = todo.text.trim();
    if (text === "" || todo.confidence < MIN_TODO_CONFIDENCE) continue;
    const key = normalizeTodoText(text);
    if (key === "" || seenTodoTexts.has(key)) continue;
    seenTodoTexts.add(key);
    todos.push({ text, confidence: todo.confidence });
  }

  const allowed = new Set(context.openTodos.map((todo) => todo.todoId));
  const seenTodos = new Set<string>();
  const completed: string[] = [];
  for (const id of output.todos_completed) {
    if (!allowed.has(id) || seenTodos.has(id)) continue;
    seenTodos.add(id);
    completed.push(id);
  }

  return parseRefineOutput({
    title: output.title.trim(),
    summary: output.summary.trim(),
    topic,
    conclusions_added: conclusions,
    todos_added: todos,
    todos_completed: completed,
  });
}

function nameKey(name: string): string {
  return canonicalTopicName(normalizeTopicName(name));
}

function createOrMatch(
  topic: RefineTopic,
  title: string,
  byName: Map<string, CandidateTopic>,
  byStem: Map<string, CandidateTopic>,
  ids: Pick<RefineIdSource, "topicId">,
): RefineTopic {
  const stem = topicStem(topic.name);
  const matched = byName.get(nameKey(topic.name)) ?? (stem === null ? undefined : byStem.get(stem));
  if (matched) return assignOf(matched);
  const name = topic.name.trim() || title.trim() || UNNAMED_TOPIC;
  return {
    action: "create",
    topicId: ids.topicId(),
    name,
    aliases: cleanAliases(topic.aliases),
  };
}
