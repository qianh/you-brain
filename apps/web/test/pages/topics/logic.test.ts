import { describe, expect, test } from "bun:test";

import {
  applyListPatch,
  findTopic,
  highlightId,
  isRecentActivity,
  joinMeta,
  moveInList,
  nextAliases,
  openTodoCountAfter,
  selectionFromRoute,
  showsNarrowDetail,
  sortConclusions,
  sortTodos,
  statusCounts,
  statusDot,
  toastQuote,
  visibleTopics,
  withTodoStatus,
} from "../../../src/pages/topics/logic.js";

const topics = [
  { topicId: "a", name: "设计", summary: "界面", nextStep: "定边界", aliases: ["G1"], zone: "active" as const, status: "active" as const, openTodoCount: 2 },
  { topicId: "b", name: "京都", summary: "行程", nextStep: "订票", aliases: ["旅行"], zone: "active" as const, status: "follow_up" as const, openTodoCount: 1 },
  { topicId: "c", name: "税务", summary: "发票", nextStep: "", aliases: ["报销"], zone: "history" as const, status: "parked" as const, openTodoCount: 0 },
  { topicId: "d", name: "读书", summary: "笔记", nextStep: "", aliases: [], zone: "history" as const, status: "done" as const, openTodoCount: 0 },
];

describe("visibleTopics", () => {
  test("keeps server order and filters by zone, status, and text", () => {
    expect(visibleTopics(topics, "active", "all", "").map((topic) => topic.topicId)).toEqual(["a", "b"]);
    expect(visibleTopics(topics, "active", "follow_up", "").map((topic) => topic.topicId)).toEqual(["b"]);
    expect(visibleTopics(topics, "history", "all", "发票").map((topic) => topic.topicId)).toEqual(["c"]);
    expect(visibleTopics(topics, "history", "done", "发票")).toEqual([]);
    expect(visibleTopics(topics, "active", "all", "旅行").map((topic) => topic.topicId)).toEqual(["b"]);
  });
});

describe("statusCounts", () => {
  test("counts every status, including zeros", () => {
    expect(statusCounts(topics.filter((topic) => topic.zone === "active"))).toEqual({
      all: 2,
      active: 1,
      follow_up: 1,
      done: 0,
      parked: 0,
    });
  });
});

describe("statusDot", () => {
  test("maps the four topic statuses", () => {
    expect(statusDot("active")).toBe("is-active");
    expect(statusDot("follow_up")).toBe("is-follow");
    expect(statusDot("done")).toBe("is-done");
    expect(statusDot("parked")).toBe("is-parked");
  });
});

describe("selection", () => {
  const ids = ["a", "b", "c"];

  test("keeps a route id only when the row exists", () => {
    expect(selectionFromRoute(ids, "b")).toBe("b");
    expect(selectionFromRoute(ids, "missing")).toBeNull();
    expect(selectionFromRoute(ids, null)).toBeNull();
    expect(selectionFromRoute(ids, "")).toBeNull();
  });

  test("moves with wrap, and starts from the ends when nothing is highlighted", () => {
    expect(moveInList(ids, "a", "prev")).toBe("c");
    expect(moveInList(ids, "c", "next")).toBe("a");
    expect(moveInList(ids, null, "next")).toBe("a");
    expect(moveInList(ids, null, "prev")).toBe("c");
    expect(moveInList([], null, "next")).toBeNull();
  });

  test("highlight follows the route on wide layouts and the cursor on a narrow list", () => {
    expect(highlightId(ids, "b", "a", false)).toBe("b");
    expect(highlightId(ids, "missing", "a", false)).toBeNull();
    expect(highlightId(ids, null, "c", true)).toBe("c");
    expect(highlightId(ids, null, "missing", true)).toBeNull();
    expect(highlightId(ids, null, null, true)).toBeNull();
    expect(showsNarrowDetail(true, "a")).toBe(true);
    expect(showsNarrowDetail(true, null)).toBe(false);
    expect(showsNarrowDetail(false, "a")).toBe(false);
  });
});

describe("isRecentActivity", () => {
  test("keeps ago phrases and leaves calendar stamps alone", () => {
    expect(isRecentActivity("26 分钟前")).toBe(true);
    expect(isRecentActivity("3 小时前")).toBe(true);
    expect(isRecentActivity("刚刚")).toBe(true);
    expect(isRecentActivity("Just now")).toBe(true);
    expect(isRecentActivity("1 minute ago")).toBe(true);
    expect(isRecentActivity("2 hours ago")).toBe(true);
    expect(isRecentActivity("昨天 10:40")).toBe(true);
    expect(isRecentActivity("Yesterday 10:40")).toBe(true);
    expect(isRecentActivity("8月2日 10:40")).toBe(false);
    expect(isRecentActivity("2025年8月2日 10:40")).toBe(false);
    expect(isRecentActivity("Aug 2, 10:40")).toBe(false);
    expect(isRecentActivity("—")).toBe(false);
  });
});

describe("findTopic", () => {
  test("returns the topic or null", () => {
    expect(findTopic(topics, "c")?.name).toBe("税务");
    expect(findTopic(topics, "nope")).toBeNull();
    expect(findTopic(topics, null)).toBeNull();
  });
});

describe("sortTodos", () => {
  test("puts open first, then done, then dropped, oldest first inside a status", () => {
    const sorted = sortTodos([
      { todoId: "d", status: "dropped", ts: "2026-10-02T00:00:00Z" },
      { todoId: "b", status: "open", ts: "2026-10-03T00:00:00Z" },
      { todoId: "c", status: "done", ts: "2026-10-01T00:00:00Z" },
      { todoId: "a", status: "open", ts: "2026-10-01T00:00:00Z" },
    ]);
    expect(sorted.map((todo) => todo.todoId)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("sortConclusions", () => {
  test("orders the timeline from oldest to newest", () => {
    const sorted = sortConclusions([
      { conclusionId: "b", ts: "2026-10-02T00:00:00Z" },
      { conclusionId: "a", ts: "2026-10-01T00:00:00Z" },
    ]);
    expect(sorted.map((item) => item.conclusionId)).toEqual(["a", "b"]);
  });
});

describe("aliases and todo counts", () => {
  test("adds and removes aliases without duplicates or blanks", () => {
    expect(nextAliases(["甲"], { type: "add", name: " 乙 " })).toEqual(["甲", "乙"]);
    expect(nextAliases(["甲"], { type: "add", name: "甲" })).toBeNull();
    expect(nextAliases(["甲"], { type: "add", name: "  " })).toBeNull();
    expect(nextAliases(["甲", "乙"], { type: "remove", name: "甲" })).toEqual(["乙"]);
    expect(nextAliases(["甲"], { type: "remove", name: "丙" })).toBeNull();
  });

  test("adjusts the open count only when a todo crosses the open state", () => {
    expect(openTodoCountAfter(2, "open", "done")).toBe(1);
    expect(openTodoCountAfter(0, "done", "open")).toBe(1);
    expect(openTodoCountAfter(1, "done", "dropped")).toBe(1);
    expect(openTodoCountAfter(0, "open", "dropped")).toBe(0);
  });

  test("marks a todo done without touching the others", () => {
    const todos: Array<{ todoId: string; status: string; statusBy: string; userLocked: boolean }> = [
      { todoId: "a", status: "open", statusBy: "auto", userLocked: false },
      { todoId: "b", status: "open", statusBy: "auto", userLocked: false },
    ];
    const next = withTodoStatus(todos, "a", "done");
    expect(next[0]).toEqual({ todoId: "a", status: "done", statusBy: "user", userLocked: true });
    expect(next[1]?.status).toBe("open");
  });
});

describe("applyListPatch", () => {
  test("patches only the matching topic", () => {
    const topic = topics[0];
    if (!topic) throw new Error("missing");
    expect(applyListPatch(topic, { topicId: "a", name: "新名字", openTodoCount: 0 }).name).toBe("新名字");
    expect(applyListPatch(topic, { topicId: "a", name: "新名字", openTodoCount: 0 }).openTodoCount).toBe(0);
    expect(applyListPatch(topic, { topicId: "b", name: "别的" }).name).toBe("设计");
    expect(applyListPatch(topic, null).name).toBe("设计");
  });
});

describe("joinMeta and toastQuote", () => {
  test("joins present parts with a middle dot", () => {
    expect(joinMeta(["手动锁定", "", null, "2 个会话", false, "3 小时前"])).toBe("手动锁定 · 2 个会话 · 3 小时前");
  });

  test("shortens a long toast quote", () => {
    expect(toastQuote("短句")).toBe("短句");
    expect(toastQuote("  a   b  ")).toBe("a b");
    expect(toastQuote("x".repeat(40))).toBe(`${"x".repeat(36)}…`);
  });
});
