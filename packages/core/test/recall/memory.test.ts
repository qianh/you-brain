import { describe, expect, it } from "bun:test";

import { buildRecallMemory } from "../../src/recall/index.js";
import { RECALL_RECENT_MS } from "../../src/recall/types.js";
import { sessionKey } from "../topics/helpers.js";
import { CURRENT, OLD, TZ, event, recallBook } from "./fixture.js";

const updated = { [OLD]: "2026-11-13T02:00:00.000Z", [CURRENT]: "2026-11-16T02:00:00.000Z" };
const NOW = Date.parse("2026-11-16T02:05:00.000Z");

function build(book = recallBook(), topicId = "topic-a", sessionUpdatedAt: Record<string, string> = updated) {
  return buildRecallMemory({ book, topicId, sessionKey: CURRENT, sessionUpdatedAt, timeZone: TZ, nowMs: NOW });
}

describe("buildRecallMemory", () => {
  it("取下一步、开放待办和最近结论，带本地日期", () => {
    const memory = build();
    expect(memory?.name).toBe("海运运价预测");
    expect(memory?.lastActiveDay).toBe("2026-11-13");
    const byId = new Map(memory?.items.map((item) => [item.id, item]));
    expect(byId.get("next")?.text).toBe("等数据到齐");
    expect(byId.get("todo:todo-1")?.day).toBe("2026-11-13");
    expect(byId.get("conclusion:con-1")?.day).toBe("2026-11-08");
  });

  it("合并进来的话题的待办也算在内，传入被合并的话题 id 也解析到目标话题", () => {
    expect(build()?.items.some((item) => item.id === "todo:todo-2")).toBe(true);
    expect(build(recallBook(), "topic-b")?.topicId).toBe("topic-a");
  });

  it("剔除当前会话产生的待办和结论", () => {
    const book = recallBook([
      event("todo.added", { todoId: "todo-now", topicId: "topic-a", text: "刚说的事", sessionKey: CURRENT, confidence: 0.9 }, "2026-11-16T02:00:00.000Z"),
      event("conclusion.added", { conclusionId: "con-now", topicId: "topic-a", text: "刚得出的结论", sessionKey: CURRENT }, "2026-11-16T02:01:00.000Z"),
    ]);
    const ids = build(book)?.items.map((item) => item.id) ?? [];
    expect(ids).not.toContain("todo:todo-now");
    expect(ids).not.toContain("conclusion:con-now");
  });

  it("近 12 小时内写过的其他会话也剔除（同一对话被采集成两份），更早的保留", () => {
    const TWIN = sessionKey(7);
    const book = recallBook([
      event("todo.added", { todoId: "todo-twin", topicId: "topic-a", text: "副本里的待办", sessionKey: TWIN, confidence: 0.9 }, "2026-11-16T01:00:00.000Z"),
      event("conclusion.added", { conclusionId: "con-twin", topicId: "topic-a", text: "副本里的结论", sessionKey: TWIN }, "2026-11-16T01:01:00.000Z"),
    ]);
    const recent = new Date(NOW - RECALL_RECENT_MS + 60_000).toISOString();
    const ids = build(book, "topic-a", { ...updated, [TWIN]: recent })?.items.map((item) => item.id) ?? [];
    expect(ids).not.toContain("todo:todo-twin");
    expect(ids).not.toContain("conclusion:con-twin");
    expect(ids).toContain("todo:todo-1");

    const old = new Date(NOW - RECALL_RECENT_MS).toISOString();
    const kept = build(book, "topic-a", { ...updated, [TWIN]: old })?.items.map((item) => item.id) ?? [];
    expect(kept).toContain("todo:todo-twin");
    expect(kept).toContain("conclusion:con-twin");
  });

  it("每条待办和结论带上写它的会话，下一步没有", () => {
    const byId = new Map(build()?.items.map((item) => [item.id, item]));
    expect(byId.get("next")?.sessionKey).toBeNull();
    expect(byId.get("todo:todo-1")?.sessionKey).toBe(OLD);
    expect(byId.get("conclusion:con-1")?.sessionKey).toBe(OLD);
  });

  it("已关闭的待办不取，只取最近 10 条结论", () => {
    const extras = Array.from({ length: 12 }, (_, index) =>
      event("conclusion.added", { conclusionId: `con-x${index}`, topicId: "topic-a", text: `结论${index}`, sessionKey: OLD }, `2026-11-10T0${index % 10}:00:00.000Z`),
    );
    const book = recallBook([
      ...extras,
      event("todo.status_changed", { todoId: "todo-1", status: "done", by: "user" }, "2026-11-14T00:00:00.000Z"),
    ]);
    const items = build(book)?.items ?? [];
    expect(items.filter((item) => item.kind === "conclusion")).toHaveLength(10);
    expect(items.map((item) => item.id)).not.toContain("todo:todo-1");
  });

  it("没有任何条目时返回 null", () => {
    expect(build(recallBook(), "topic-c")).toBeNull();
    expect(build(recallBook(), "topic-none")).toBeNull();
  });
});
