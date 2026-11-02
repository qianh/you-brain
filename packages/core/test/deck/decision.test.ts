import { describe, expect, it } from "bun:test";

import { parseDecision } from "../../src/deck/decision.js";

describe("deck decision", () => {
  it("parses an answer decision", () => {
    const decision = parseDecision('{"kind":"answer","text":"今天有 3 个会话"}');
    expect(decision).toEqual({ kind: "answer", text: "今天有 3 个会话" });
  });

  it("parses a dispatch decision embedded in prose", () => {
    const raw = `好的，我来安排。\n\n{"kind":"dispatch","title":"查 X 上 AI 新闻","executor":{"kind":"gui-app","id":"grok-bot"},"prompt":"搜索 X 上今天的 AI 新闻并汇总"}\n\n请稍候。`;
    const decision = parseDecision(raw);
    expect(decision).toMatchObject({ kind: "dispatch", title: "查 X 上 AI 新闻" });
  });

  it("parses a schedule decision", () => {
    const raw =
      '{"kind":"schedule","title":"每日早报","executor":{"kind":"capability","id":"today"},"prompt":"汇总过去 24 小时会话","schedule":{"kind":"daily","time":"08:00"}}';
    const decision = parseDecision(raw);
    expect(decision).toMatchObject({ kind: "schedule", schedule: { kind: "daily", time: "08:00" } });
  });

  it("rejects an unknown executor kind", () => {
    expect(
      parseDecision('{"kind":"dispatch","title":"x","executor":{"kind":"magic","id":"a"},"prompt":"p"}'),
    ).toBeNull();
  });

  it("falls back to null on garbage", () => {
    expect(parseDecision("这不是 JSON")).toBeNull();
    expect(parseDecision("")).toBeNull();
    expect(parseDecision('{"kind":"nonsense"}')).toBeNull();
  });
});
