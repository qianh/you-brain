import { describe, expect, it } from "bun:test";

import { parseDecision } from "../../src/deck/decision.js";
import { createDecisionDisplay } from "../../src/deck/master.js";

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

describe("decision display stream", () => {
  function feed(chunks: string[]): { shown: string[]; final: string } {
    const display = createDecisionDisplay();
    const shown: string[] = [];
    let text = "";
    for (const chunk of chunks) {
      text += chunk;
      const delta = display.push(text);
      if (delta !== "") {
        shown.push(delta);
      }
    }
    return { shown, final: display.text() };
  }

  it("extracts the answer text incrementally across arbitrary chunk boundaries", () => {
    const full = '{"kind":"answer","text":"费曼学习法是用「讲给别人听」来检验理解。"}';
    // 按 3 字符一块喂入，模拟逐字流。
    const chunks: string[] = [];
    for (let i = 0; i < full.length; i += 3) chunks.push(full.slice(i, i + 3));
    const { shown, final } = feed(chunks);
    expect(shown.join("")).toBe("费曼学习法是用「讲给别人听」来检验理解。");
    expect(final).toBe("费曼学习法是用「讲给别人听」来检验理解。");
  });

  it("decodes escapes inside the text field", () => {
    const { final } = feed(['{"kind":"answer","text":"第一行\\n第二行 \\"引话\\""}']);
    expect(final).toBe('第一行\n第二行 "引话"');
  });

  it("shows nothing for decisions without a text field", () => {
    const { final } = feed([
      '{"kind":"dispatch","title":"写诗","executor":{"kind":"cli-agent","id":"grok-cli"},"prompt":"写一首诗"}',
    ]);
    expect(final).toBe("");
  });

  it("passes prose through as-is (parseDecision fallback case)", () => {
    const { shown, final } = feed(["这是", "一个直接", "回答。"]);
    expect(shown.join("")).toBe("这是一个直接回答。");
    expect(final).toBe("这是一个直接回答。");
  });
});
