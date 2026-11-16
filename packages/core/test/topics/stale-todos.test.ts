import { describe, expect, it } from "bun:test";

import { selectStaleOpenTodos } from "../../src/topics/stale-todos.js";
import type { TodoState } from "../../src/topics/types.js";

function todo(todoId: string, status: TodoState["status"], ts: string, extra: Partial<TodoState> = {}): TodoState {
  return {
    todoId,
    topicId: "topic-a",
    sessionKey: "s",
    text: todoId,
    status,
    statusBy: "auto",
    confidence: 0.9,
    ts,
    userLocked: false,
    ...extra,
  };
}

describe("selectStaleOpenTodos", () => {
  const now = Date.parse("2026-11-16T08:00:00.000Z");

  it("只选开放、未被本人改过、创建早于 N 天的待办", () => {
    const picked = selectStaleOpenTodos(
      [
        todo("old-open", "open", "2026-11-08T07:59:59.000Z"),
        todo("edge", "open", "2026-11-09T08:00:00.000Z"),
        todo("recent", "open", "2026-11-15T00:00:00.000Z"),
        todo("old-done", "done", "2026-10-01T00:00:00.000Z"),
        todo("old-dropped", "dropped", "2026-10-01T00:00:00.000Z"),
        todo("old-locked", "open", "2026-10-01T00:00:00.000Z", { userLocked: true }),
        todo("bad-ts", "open", "not-a-date"),
      ],
      now,
      7,
    );
    expect(picked.map((item) => item.todoId)).toEqual(["old-open"]);
  });

  it("没有待办时返回空数组", () => {
    expect(selectStaleOpenTodos([], now, 7)).toEqual([]);
  });
});
