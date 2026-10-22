import type { TopicStatus } from "@you-brain/protocol";

import { filterTopics, type TopicFilterFields } from "../../lib/group.js";
import { nextIndex } from "../../lib/list-nav.js";

export const STATUS_FILTERS = ["all", "active", "follow_up", "done", "parked"] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

export type DotKind = "is-active" | "is-follow" | "is-done" | "is-parked";

const TODO_RANK: Record<string, number> = { open: 0, done: 1, dropped: 2 };

export interface ZonedTopic {
  zone: "active" | "history";
  status: TopicStatus;
}

export type StatusLabelKey = "statusActiveLabel" | "statusFollowLabel" | "statusDoneLabel" | "statusParkedLabel";

export function statusDot(status: TopicStatus): DotKind {
  if (status === "active") return "is-active";
  if (status === "follow_up") return "is-follow";
  if (status === "done") return "is-done";
  return "is-parked";
}

export function statusLabelKey(status: TopicStatus): StatusLabelKey {
  if (status === "follow_up") return "statusFollowLabel";
  if (status === "done") return "statusDoneLabel";
  if (status === "parked") return "statusParkedLabel";
  return "statusActiveLabel";
}

export function statusCounts<T extends { status: TopicStatus }>(
  topics: readonly T[],
): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = {
    all: topics.length,
    active: 0,
    follow_up: 0,
    done: 0,
    parked: 0,
  };
  for (const topic of topics) counts[topic.status] += 1;
  return counts;
}

export function visibleTopics<T extends TopicFilterFields & ZonedTopic>(
  topics: readonly T[],
  zone: "active" | "history",
  filter: StatusFilter,
  query: string,
): T[] {
  const inZone = topics.filter((topic) => topic.zone === zone);
  const matched = filterTopics(inZone, query);
  if (filter === "all") return matched;
  return matched.filter((topic) => topic.status === filter);
}

/** Route id wins when it is still in the list. Otherwise nothing is selected. */
export function selectionFromRoute(ids: readonly string[], routeId: string | null): string | null {
  if (routeId === null || routeId === "") return null;
  return ids.includes(routeId) ? routeId : null;
}

export function moveInList(
  ids: readonly string[],
  current: string | null,
  direction: "next" | "prev",
): string | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  const key = direction === "next" ? "ArrowDown" : "ArrowUp";
  const next = nextIndex(index, ids.length, key);
  return ids[next] ?? null;
}

/**
 * Wide layout highlights the route id when that row is visible.
 * A narrow list highlights the cursor only when that row is still visible.
 * Nothing is highlighted until the user moves.
 */
export function highlightId(
  visibleIds: readonly string[],
  routeId: string | null,
  cursorId: string | null,
  narrowList: boolean,
): string | null {
  if (narrowList) {
    if (cursorId !== null && visibleIds.includes(cursorId)) return cursorId;
    return null;
  }
  if (routeId !== null && visibleIds.includes(routeId)) return routeId;
  return null;
}

/**
 * formatRelative 的「刚刚 / N 分钟前 / 昨天」才套「最近」。
 * 同年或跨年的日历戳原样展示。
 */
export function isRecentActivity(relative: string): boolean {
  const text = relative.trim();
  if (text === "刚刚" || text === "Just now") return true;
  if (text.startsWith("昨天") || text.startsWith("Yesterday")) return true;
  if (text.endsWith("前") || text.endsWith(" ago")) return true;
  return false;
}

export function showsNarrowDetail(narrow: boolean, routeId: string | null): boolean {
  return narrow && routeId !== null && routeId !== "";
}

export function findTopic<T extends { topicId: string }>(
  topics: readonly T[],
  id: string | null,
): T | null {
  if (id === null || id === "") return null;
  return topics.find((topic) => topic.topicId === id) ?? null;
}

export function sortTodos<T extends { status: string; ts: string; todoId: string }>(
  todos: readonly T[],
): T[] {
  return [...todos].sort((left, right) => {
    const rank = (TODO_RANK[left.status] ?? 9) - (TODO_RANK[right.status] ?? 9);
    if (rank !== 0) return rank;
    const leftMs = Date.parse(left.ts);
    const rightMs = Date.parse(right.ts);
    const leftOk = Number.isFinite(leftMs);
    const rightOk = Number.isFinite(rightMs);
    if (leftOk && rightOk && leftMs !== rightMs) return leftMs - rightMs;
    if (leftOk !== rightOk) return leftOk ? -1 : 1;
    if (left.todoId < right.todoId) return -1;
    if (left.todoId > right.todoId) return 1;
    return 0;
  });
}

export function sortConclusions<T extends { ts: string; conclusionId: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) => {
    const leftMs = Date.parse(left.ts);
    const rightMs = Date.parse(right.ts);
    const leftOk = Number.isFinite(leftMs);
    const rightOk = Number.isFinite(rightMs);
    if (leftOk && rightOk && leftMs !== rightMs) return leftMs - rightMs;
    if (leftOk !== rightOk) return leftOk ? -1 : 1;
    if (left.conclusionId < right.conclusionId) return -1;
    if (left.conclusionId > right.conclusionId) return 1;
    return 0;
  });
}

export function nextAliases(
  current: readonly string[],
  action: { type: "add"; name: string } | { type: "remove"; name: string },
): string[] | null {
  if (action.type === "remove") {
    if (!current.includes(action.name)) return null;
    return current.filter((alias) => alias !== action.name);
  }
  const name = action.name.trim();
  if (name === "" || current.includes(name)) return null;
  return [...current, name];
}

export function openTodoCountAfter(count: number, from: string, to: string): number {
  const wasOpen = from === "open";
  const willOpen = to === "open";
  if (wasOpen && !willOpen) return Math.max(0, count - 1);
  if (!wasOpen && willOpen) return count + 1;
  return count;
}

export function withTodoStatus<T extends { todoId: string; status: string; statusBy: string; userLocked: boolean }>(
  todos: readonly T[],
  todoId: string,
  status: T["status"],
): T[] {
  return todos.map((todo) =>
    todo.todoId === todoId ? { ...todo, status, statusBy: "user", userLocked: true } : todo,
  );
}

export interface ListPatch {
  topicId: string;
  name?: string;
  status?: TopicStatus;
  aliases?: string[];
  openTodoCount?: number;
}

export function applyListPatch<T extends { topicId: string; name: string; status: TopicStatus; aliases: string[]; openTodoCount: number }>(
  topic: T,
  patch: ListPatch | null,
): T {
  if (patch === null || patch.topicId !== topic.topicId) return topic;
  return {
    ...topic,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.aliases !== undefined ? { aliases: patch.aliases } : {}),
    ...(patch.openTodoCount !== undefined ? { openTodoCount: patch.openTodoCount } : {}),
  };
}

export function joinMeta(parts: readonly (string | null | undefined | false)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join(" · ");
}

export function toastQuote(text: string, max = 36): string {
  const trimmed = text.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}…`;
}
