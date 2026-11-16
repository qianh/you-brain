import { describe, expect, it } from "bun:test";

import {
  RECALL_USER_CHARS,
  buildRecallPrompt,
  parseRecallDecision,
  type RecallMemory,
} from "../../src/recall/index.js";

const memory: RecallMemory = {
  topicId: "topic-a",
  name: "海运运价预测",
  summary: "预测海运运价",
  lastActiveDay: "2026-11-13",
  items: [
    { id: "next", kind: "next_step", text: "等数据到齐", day: null, sessionKey: null },
    { id: "todo:todo-1", kind: "todo", text: "接入 10 月运价数据后重训", day: "2026-11-13", sessionKey: "s".repeat(64) },
  ],
};

const ok = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ say: true, grade: "normal", text: "11-13 你说等 10 月数据到了再重训，还没接。", basisId: "todo:todo-1", ...extra });

describe("parseRecallDecision", () => {
  it("不说", () => {
    expect(parseRecallDecision('{"say": false}', memory)).toEqual({ say: false });
  });

  it("说，并带上档位和依据", () => {
    expect(parseRecallDecision(ok({ grade: "important" }), memory)).toEqual({
      say: true,
      grade: "important",
      text: "11-13 你说等 10 月数据到了再重训，还没接。",
      basisId: "todo:todo-1",
    });
  });

  it("依据不在记忆里时当作不说", () => {
    expect(parseRecallDecision(ok({ basisId: "todo:none" }), memory)).toEqual({ say: false });
  });

  it.each([
    ["档位不在枚举里", ok({ grade: "urgent" })],
    ["正文为空", ok({ text: "  " })],
    ["正文含换行", ok({ text: "第一行\n第二行" })],
    ["正文超过 60 字", ok({ text: "字".repeat(61) })],
    ["缺少依据", ok({ basisId: "" })],
    ["不是 JSON", "不是 JSON"],
  ])("输出不合规时抛错：%s", (_name, raw) => {
    expect(() => parseRecallDecision(raw, memory)).toThrow();
  });

  it("60 字整正好可以", () => {
    expect(parseRecallDecision(ok({ text: "字".repeat(60) }), memory).say).toBe(true);
  });
});

describe("buildRecallPrompt", () => {
  it("带上记忆的 id 与日期，并按时间正序给出用户发言", () => {
    const { user } = buildRecallPrompt({ memory, userTurns: ["第一句", "第二句"], today: "2026-11-16" });
    expect(user).toContain("[todo:todo-1] 2026-11-13 接入 10 月运价数据后重训");
    expect(user).toContain("[next] - 等数据到齐");
    expect(user.indexOf("第一句")).toBeLessThan(user.indexOf("第二句"));
  });

  it("用户发言超过 6000 字时保留最新的部分", () => {
    const old = "旧".repeat(RECALL_USER_CHARS);
    const { user } = buildRecallPrompt({ memory, userTurns: [old, "最新的话"], today: "2026-11-16" });
    expect(user).toContain("最新的话");
    const kept = (user.match(/旧/gu) ?? []).length;
    expect(kept).toBe(RECALL_USER_CHARS - Array.from("最新的话").length);
  });
});
