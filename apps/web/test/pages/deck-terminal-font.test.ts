import { describe, expect, test } from "bun:test";

import { FALLBACK_APPEARANCE, resolveAppearance, stepFontSize } from "../../src/pages/deck-terminal-font.js";

const TTY7 = { fontFamily: '"Hack", "Menlo", monospace', fontSize: 13, lineHeight: 1.4 };

describe("resolveAppearance", () => {
  test("没有存储也没有 tty7 配置时用 12 / 1.2", () => {
    expect(resolveAppearance(null, null)).toEqual({
      fontFamily: '"SFMono-Regular", Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.2,
    });
    expect(FALLBACK_APPEARANCE.fontSize).toBe(12);
  });

  test("有 tty7 配置时字体、字号、行高跟随 tty7", () => {
    expect(resolveAppearance(null, TTY7)).toEqual(TTY7);
  });

  test("用户调过的字号优先于 tty7", () => {
    expect(resolveAppearance("15", TTY7)).toEqual({ ...TTY7, fontSize: 15 });
    expect(resolveAppearance("15", null).fontSize).toBe(15);
  });

  test("存储值非法时忽略", () => {
    for (const bad of ["abc", "8", "25", "13.5", "", " 15", "1e1"]) {
      expect(resolveAppearance(bad, TTY7).fontSize).toBe(13);
      expect(resolveAppearance(bad, null).fontSize).toBe(12);
    }
  });

  test("9 和 24 是合法边界", () => {
    expect(resolveAppearance("9", TTY7).fontSize).toBe(9);
    expect(resolveAppearance("24", TTY7).fontSize).toBe(24);
  });
});

describe("stepFontSize", () => {
  test("在 9 和 24 处停住", () => {
    expect(stepFontSize(13, 1)).toBe(14);
    expect(stepFontSize(13, -1)).toBe(12);
    expect(stepFontSize(9, -1)).toBe(9);
    expect(stepFontSize(24, 1)).toBe(24);
  });
});
