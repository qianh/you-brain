import { describe, expect, it } from "bun:test";

import {
  RECALL_USER_CHARS,
  buildRecallPrompt,
  parseRecallDecision,
  stripRecallBoilerplate,
  type RecallHistoryItem,
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

const history: RecallHistoryItem[] = [
  {
    id: "history:abc123",
    sessionKey: "s".repeat(64),
    day: "2026-11-08",
    title: "运价预测讨论",
    text: "我想预测海运运价，先按月聚合试试。",
  },
];

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

  it("依据是历史会话片段时可以说", () => {
    expect(
      parseRecallDecision(ok({ basisId: "history:abc123" }), memory, history),
    ).toEqual({
      say: true,
      grade: "normal",
      text: "11-13 你说等 10 月数据到了再重训，还没接。",
      basisId: "history:abc123",
    });
  });

  it("没传入历史时引用片段 id 当作不说", () => {
    expect(parseRecallDecision(ok({ basisId: "history:abc123" }), memory)).toEqual({ say: false });
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

  it("历史片段与回复都进入提示词，超长片段保留尾部", () => {
    const long = "前".repeat(3000) + "结尾才是重点";
    const { user } = buildRecallPrompt({
      memory,
      userTurns: ["第一句"],
      today: "2026-11-16",
      history: [{ ...history[0]!, text: long }],
      replies: [{ day: "2026-11-14", text: "重训的事月底再说" }],
    });
    expect(user).toContain("## 历史会话片段");
    expect(user).toContain("[history:abc123] 2026-11-08 会话「运价预测讨论」他说过：");
    expect(user).toContain("结尾才是重点");
    expect(user).not.toContain("前".repeat(2500));
    expect(user).toContain("他回复过：重训的事月底再说");
    expect(user).toContain("（已处理，不要再提）");
  });

  it("没有历史与回复时不留空段", () => {
    const { user } = buildRecallPrompt({ memory, userTurns: ["第一句"], today: "2026-11-16" });
    expect(user).toContain("## 历史会话片段\n（无）");
    expect(user).not.toContain("他回复过");
  });

  it("剥离 Codex 注入的 AGENTS.md 块，并展示近期进展与当前会话助手回复供过时核对", () => {
    const rawTurn = `# AGENTS.md instructions for /tmp/repo\n\n<INSTRUCTIONS>\n长篇编码准则\n</INSTRUCTIONS>\n帮我重新打一个新包`;
    expect(stripRecallBoilerplate(rawTurn)).toBe("帮我重新打一个新包");

    const withFacts: RecallMemory = {
      ...memory,
      recentFacts: [{ day: "2026-11-18", text: "新包 contract-compare-20261118.zip 已生成" }],
    };
    const { user } = buildRecallPrompt({
      memory: withFacts,
      userTurns: [rawTurn, "默认包也是最新的吗"],
      today: "2026-11-18",
      dialogue: [
        { role: "user", text: "帮我重新打一个新包" },
        { role: "assistant", text: "最新包已重打为 contract-compare-20261118.zip" },
      ],
    });
    expect(user).not.toContain("长篇编码准则");
    expect(user).toContain("帮我重新打一个新包");
    expect(user).toContain("近期进展与后续结论");
    expect(user).toContain("新包 contract-compare-20261118.zip 已生成");
    expect(user).toContain("当前会话助手最近回复");
    expect(user).toContain("最新包已重打为 contract-compare-20261118.zip");
  });
});
