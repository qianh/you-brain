import { parseRefineOutput, type RefineOutput, type RefineTopic } from "@you-brain/protocol";

import type { CandidateTopic, OpenTodo, PreviousRefine, RefineIdSource } from "./types.js";

export const MIN_TODO_CONFIDENCE = 0.8;
const UNNAMED_TOPIC = "未命名话题";

export function normalizeTopicName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function normalizeConclusion(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
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
  topics: readonly CandidateTopic[];
  openTodos: readonly OpenTodo[];
  previous: PreviousRefine | null;
  ids: Pick<RefineIdSource, "topicId">;
}

/**
 * create whose normalized name matches an existing topic becomes assign.
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
  for (const topic of context.topics) {
    const key = normalizeTopicName(topic.name);
    if (key !== "" && !byName.has(key)) byName.set(key, topic);
  }

  let topic: RefineTopic;
  if (output.topic.action === "assign") {
    const existing = byId.get(output.topic.topicId);
    topic = existing ? assignOf(existing) : createOrMatch(output.topic, output.title, byName, context.ids);
  } else {
    topic = createOrMatch(output.topic, output.title, byName, context.ids);
  }

  const seenConclusions = new Set(
    (context.previous?.conclusions ?? []).map((item) => normalizeConclusion(item)),
  );
  const conclusions: string[] = [];
  for (const item of output.conclusions_added) {
    const text = item.trim();
    const key = normalizeConclusion(text);
    if (key === "" || seenConclusions.has(key)) continue;
    seenConclusions.add(key);
    conclusions.push(text);
  }

  const todos = output.todos_added
    .map((todo) => ({ text: todo.text.trim(), confidence: todo.confidence }))
    .filter((todo) => todo.text !== "" && todo.confidence >= MIN_TODO_CONFIDENCE);

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

function createOrMatch(
  topic: RefineTopic,
  title: string,
  byName: Map<string, CandidateTopic>,
  ids: Pick<RefineIdSource, "topicId">,
): RefineTopic {
  const matched = byName.get(normalizeTopicName(topic.name));
  if (matched) return assignOf(matched);
  const name = topic.name.trim() || title.trim() || UNNAMED_TOPIC;
  return {
    action: "create",
    topicId: ids.topicId(),
    name,
    aliases: cleanAliases(topic.aliases),
  };
}
