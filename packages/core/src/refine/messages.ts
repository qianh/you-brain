import { DEFAULT_HISTORY_TOPIC_CANDIDATES } from "@you-brain/protocol";

import { rankTopicsByText } from "../topics/similarity.js";
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
  /** Number of input messages consumed by this batch (advances `refinedUpTo`). */
  consumed: number;
  /** True when a single oversized message had to be clipped to fit the budget. */
  truncated: boolean;
  /** True when later messages remain after `consumed` for the next refine pass. */
  hasMore: boolean;
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
 * Take the earliest new messages in chronological order that fit `budget`.
 *
 * Advancing forward in batches ensures early architecture decisions and conclusions
 * are refined first rather than dropped; remaining messages stay above `refinedUpTo`
 * so the next pass refines them with this batch's output as `previous`.
 * When the very first message alone exceeds `budget`, its tail is kept and `consumed`
 * is still 1 so `refinedUpTo` never stalls.
 */
export function fitRefineMessages(
  messages: readonly RefineMessage[],
  budget = DEFAULT_REFINE_CHAR_BUDGET,
): FittedMessages {
  if (messages.length === 0) {
    return { messages: [], consumed: 0, truncated: false, hasMore: false };
  }
  if (budget <= 0) {
    return { messages: [], consumed: 0, truncated: true, hasMore: true };
  }
  const first = messages[0]!;
  if (charCount(messageBlock(first)) > budget) {
    const room = Math.max(0, budget - charCount(`[${first.role}]\n`));
    return {
      messages: [{ role: first.role, text: takeTail(first.text, room) }],
      consumed: 1,
      truncated: true,
      hasMore: messages.length > 1,
    };
  }
  const kept: RefineMessage[] = [first];
  let total = charCount(messageBlock(first));
  for (let index = 1; index < messages.length; index += 1) {
    const next = messages[index]!;
    const extra = 2 + charCount(messageBlock(next));
    if (total + extra > budget) break;
    kept.push(next);
    total += extra;
  }
  return {
    messages: kept,
    consumed: kept.length,
    truncated: false,
    hasMore: kept.length < messages.length,
  };
}

function historyRank(topics: readonly CandidateTopic[]): CandidateTopic[] {
  const dated = topics.some((topic) => topic.recency !== undefined);
  if (!dated) return [...topics];
  return [...topics].sort(
    (left, right) => (right.recency ?? Number.NEGATIVE_INFINITY) - (left.recency ?? Number.NEGATIVE_INFINITY),
  );
}

/** Of the history slots, how many go to topics that match the text. The rest go by recency. */
const RELEVANT_SHARE = 0.75;
/** Below this the only thing shared is a stray pair of characters. */
const MIN_RELEVANCE = 0.05;
/** Enough to tell what a session is about. A long paste should not outweigh its opening. */
const QUERY_CHARS = 6_000;

export interface CandidateRelevance {
  /** What the session is about. History topics matching it are offered first. */
  query: string;
  /** The topic the session already sits on. Always offered. */
  currentTopicId?: string | null;
}

/** The text to match topics against: the earlier refine plus what the user wrote. */
export function candidateQuery(
  previous: { title: string; summary: string } | null,
  messages: readonly RefineMessage[],
): string {
  const spoken = messages.filter((message) => message.role === "user");
  const text = (spoken.length > 0 ? spoken : messages).map((message) => message.text).join("\n");
  const head = previous ? `${previous.title}\n${previous.summary}\n` : "";
  return `${head}${Array.from(text).slice(0, QUERY_CHARS).join("")}`;
}

/**
 * Active topics, the topic the session is already on, and history topics (default 20):
 * the ones matching the session first, then the most recent. Offering only recent ones
 * hides the right topic as soon as the book outgrows the limit, and the model then has
 * no choice but to open a duplicate.
 */
export function selectCandidateTopics(
  topics: readonly CandidateTopic[],
  historyLimit = DEFAULT_HISTORY_TOPIC_CANDIDATES,
  relevance?: CandidateRelevance,
): CandidateTopic[] {
  const active = topics.filter((topic) => topic.zone === "active");
  const history = topics.filter((topic) => topic.zone === "history");
  const dated = history.some((topic) => topic.recency !== undefined);
  const limit = Math.max(0, historyLimit);
  const relevant = relevance
    ? rankTopicsByText(history, relevance.query)
        .filter((item) => item.score >= MIN_RELEVANCE)
        .slice(0, Math.ceil(limit * RELEVANT_SHARE))
        .map((item) => item.topic)
    : [];
  const relevantIds = new Set(relevant.map((topic) => topic.topicId));
  const rest = history.filter((topic) => !relevantIds.has(topic.topicId));
  const room = limit - relevant.length;
  const recent =
    room <= 0
      ? []
      : dated
        ? historyRank(rest).slice(0, room)
        : rest.slice(-room);
  const current = relevance?.currentTopicId
    ? topics.filter((topic) => topic.topicId === relevance.currentTopicId)
    : [];
  const seen = new Set<string>();
  const selected: CandidateTopic[] = [];
  for (const topic of [...current, ...active, ...relevant, ...recent]) {
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
