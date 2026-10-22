import { describe, expect, test } from "bun:test";

import { countReadingChars, formatReadingCount, scrollBehavior, writeClipboard } from "../../src/pages/portrait/logic.js";

describe("portrait reading helpers", () => {
  test("counts graphemes after stripping whitespace", () => {
    expect(countReadingChars("你好 世界")).toBe(4);
    expect(countReadingChars("a\u0301 b")).toBe(2);
    expect(countReadingChars("  \n")).toBe(0);
  });

  test("formats the count for the page template", () => {
    expect(formatReadingCount(4200, "zh")).toBe(new Intl.NumberFormat("zh-CN").format(4200));
    expect(formatReadingCount(4200, "en")).toBe(new Intl.NumberFormat("en-US").format(4200));
  });

  test("reports whether the clipboard write landed", async () => {
    expect(await writeClipboard("path", async () => undefined)).toBe(true);
    expect(
      await writeClipboard("path", async () => {
        throw new Error("denied");
      }),
    ).toBe(false);
  });

  test("does not ask for smooth scrolling when motion is reduced or unavailable", () => {
    if (typeof window === "undefined") {
      expect(scrollBehavior()).toBe("auto");
      return;
    }
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
      onchange: null,
    })) as typeof window.matchMedia;
    expect(scrollBehavior()).toBe("auto");
    window.matchMedia = original;
  });
});
