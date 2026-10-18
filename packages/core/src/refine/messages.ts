import { DEFAULT_HISTORY_TOPIC_CANDIDATES } from "@you-brain/protocol";

import type { CandidateTopic, OpenTodo, RefineMessage } from "./types.js";

export const DEFAULT_REFINE_CHAR_BUDGET = 24_000;

export function messageBlock(message: RefineMessage): string {
  return `[${message.role}]\n${message.text}`;
}

function charCount(text: string): number {
  return Array.from(text).length;
}

function takeTail(text: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(text);
  if (characters.length <= count) return text;
  return characters.slice(-count).join("");
}

export interface FittedMessages {
  messages: RefineMessage[];
  truncated: boolean;
}

function joinedLength(messages: readonly RefineMessage[]): number {
  let total = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (index > 0) total += 2;
    total += charCount(messageBlock(message));
  }
  return total;
}

/**
 * Keep the newest new-messages that fit the character budget.
 * Whole earliest messages are dropped first. A single remaining message
 * that is still too long keeps its tail. refinedUpTo still advances past
 * the dropped prefix: the next run only sees messages after this batch.
 */
export function fitRefineMessages(
  messages: readonly RefineMessage[],
  budget = DEFAULT_REFINE_CHAR_BUDGET,
): FittedMessages {
  if (messages.length === 0) return { messages: [], truncated: false };
  if (budget <= 0) return { messages: [], truncated: true };
  const kept = [...messages];
  while (kept.length > 1 && joinedLength(kept) > budget) kept.shift();
  const only = kept[0];
  if (kept.length === 1 && only && charCount(messageBlock(only)) > budget) {
    const room = Math.max(0, budget - charCount(`[${only.role}]\n`));
    return {
      messages: [{ role: only.role, text: takeTail(only.text, room) }],
      truncated: true,
    };
  }
  return { messages: kept, truncated: kept.length !== messages.length };
}

function historyRank(topics: readonly CandidateTopic[]): CandidateTopic[] {
  const dated = topics.some((topic) => topic.recency !== undefined);
  if (!dated) return [...topics];
  return [...topics].sort(
    (left, right) => (right.recency ?? Number.NEGATIVE_INFINITY) - (left.recency ?? Number.NEGATIVE_INFINITY),
  );
}

/** Active topics, plus the most recent history topics (default 20). */
export function selectCandidateTopics(
  topics: readonly CandidateTopic[],
  historyLimit = DEFAULT_HISTORY_TOPIC_CANDIDATES,
): CandidateTopic[] {
  const active = topics.filter((topic) => topic.zone === "active");
  const history = topics.filter((topic) => topic.zone === "history");
  const dated = history.some((topic) => topic.recency !== undefined);
  const limit = Math.max(0, historyLimit);
  const recent =
    limit === 0
      ? []
      : dated
        ? historyRank(history).slice(0, limit)
        : history.slice(-limit);
  const seen = new Set<string>();
  const selected: CandidateTopic[] = [];
  for (const topic of [...active, ...recent]) {
    if (seen.has(topic.topicId)) continue;
    seen.add(topic.topicId);
    selected.push(topic);
  }
  return selected;
}

export function selectOpenTodos(
  todos: readonly OpenTodo[],
  topics: readonly CandidateTopic[],
): OpenTodo[] {
  const ids = new Set(topics.map((topic) => topic.topicId));
  return todos.filter((todo) => ids.has(todo.topicId));
}
