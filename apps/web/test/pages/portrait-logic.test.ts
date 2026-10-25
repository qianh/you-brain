import { describe, expect, test } from "bun:test";

import {
  countReadingChars,
  formatReadingCount,
  portraitEmptyCopy,
  scrollBehavior,
  snapshotVersion,
  writeClipboard,
} from "../../src/pages/portrait/logic.js";

describe("portraitEmptyCopy", () => {
  test("says consolidation is off only when the status says so", () => {
    expect(portraitEmptyCopy({ consolidation: { enabled: false, status: "disabled", stale: false, lastFinishedAt: null }, time: "10:00" })).toEqual({
      kind: "off",
    });
    expect(portraitEmptyCopy({ consolidation: { enabled: false, status: "disabled", stale: false, lastFinishedAt: null }, time: null })).toEqual({
      kind: "off",
    });
  });

  test("shows the configured time when consolidation is on", () => {
    const on = { enabled: true, status: "ok" as const, stale: false, lastFinishedAt: null };
    expect(portraitEmptyCopy({ consolidation: on, time: "07:30" })).toEqual({ kind: "scheduled", time: "07:30" });
    expect(portraitEmptyCopy({ consolidation: on, time: " 23:59 " })).toEqual({ kind: "scheduled", time: "23:59" });
    // A missing or malformed time keeps the original copy.
    expect(portraitEmptyCopy({ consolidation: on, time: "" })).toEqual({ kind: "default" });
    expect(portraitEmptyCopy({ consolidation: on, time: "25:00" })).toEqual({ kind: "default" });
    expect(portraitEmptyCopy({ consolidation: on, time: undefined })).toEqual({ kind: "default" });
  });

  test("keeps the original copy while the status is unknown", () => {
    expect(portraitEmptyCopy({ consolidation: null, time: "07:30" })).toEqual({ kind: "default" });
    expect(portraitEmptyCopy({ consolidation: undefined, time: null })).toEqual({ kind: "default" });
  });
});

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

  test("shows a version token and keeps an untitled name readable", () => {
    expect(snapshotVersion("JOHN-DIGITAL-TWIN-v13.md")).toBe("v13");
    expect(snapshotVersion("JOHN-DIGITAL-TWIN-v1.3.2.md")).toBe("v1.3.2");
    expect(snapshotVersion("notes.md")).toBe("notes");
    expect(snapshotVersion(".md")).toBe(".md");
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
