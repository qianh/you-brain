import type { TodoState } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Open todos created more than `days` days before `nowMs`.
 *
 * Todos the user touched are left alone (`userLocked`), and a todo whose creation time
 * cannot be read is kept: with nothing to judge by, closing it would be a guess.
 */
export function selectStaleOpenTodos(
  todos: readonly TodoState[],
  nowMs: number,
  days: number,
): TodoState[] {
  const cutoff = nowMs - days * DAY_MS;
  return todos.filter((todo) => {
    if (todo.status !== "open" || todo.userLocked) return false;
    const created = Date.parse(todo.ts);
    return !Number.isNaN(created) && created < cutoff;
  });
}
