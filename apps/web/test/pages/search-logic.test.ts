import { describe, expect, test } from "bun:test";

import {
  flattenExcerpt,
  formatScore,
  hasActiveFilters,
  highlightParts,
  joinNotice,
  nextSources,
  parseSearchSources,
  rangeBounds,
  relevanceCells,
  searchNoticeLines,
  startOfZonedDay,
  suggestionNames,
} from "../../src/pages/search/logic.js";

const NOW = new Date("2026-10-21T02:30:00+08:00");

describe("rangeBounds", () => {
  test("maps local calendar days in Asia/Shanghai to inclusive ISO instants", () => {
    expect(startOfZonedDay(NOW, "Asia/Shanghai").toISOString()).toBe("2026-10-20T16:00:00.000Z");
    expect(rangeBounds("all", NOW, "Asia/Shanghai")).toEqual({});
    expect(rangeBounds("today", NOW, "Asia/Shanghai")).toEqual({
      from: "2026-10-20T16:00:00.000Z",
      to: "2026-10-21T15:59:59.999Z",
    });
    expect(rangeBounds("7d", NOW, "Asia/Shanghai").from).toBe("2026-10-14T16:00:00.000Z");
    expect(rangeBounds("30d", NOW, "Asia/Shanghai").from).toBe("2026-09-21T16:00:00.000Z");
    expect(rangeBounds("30d", NOW, "Asia/Shanghai").to).toBe("2026-10-21T15:59:59.999Z");
  });

  test("falls back to UTC when the time zone is not real", () => {
    expect(startOfZonedDay(NOW, "Not/AZone").toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });
});

describe("search filters", () => {
  test("reads source and sources, then keeps the catalog order", () => {
    expect(parseSearchSources("?source=codex&sources=grok-build,claude-code,nope")).toEqual([
      "claude-code",
      "codex",
      "grok-build",
    ]);
    expect(nextSources(["codex"], "claude-code")).toEqual(["claude-code", "codex"]);
    expect(nextSources(["codex", "cursor"], "codex")).toEqual(["cursor"]);
    expect(hasActiveFilters([], "all")).toBe(false);
    expect(hasActiveFilters(["codex"], "all")).toBe(true);
    expect(hasActiveFilters([], "7d")).toBe(true);
  });

  test("suggests the four most recently active topic names", () => {
    expect(
      suggestionNames([
        { name: " 旧 ", lastActive: "2026-01-01T00:00:00.000Z" },
        { name: "新", lastActive: "2026-10-01T00:00:00.000Z" },
        { name: "新", lastActive: "2026-09-01T00:00:00.000Z" },
        { name: "   ", lastActive: "2026-11-01T00:00:00.000Z" },
        { name: "中", lastActive: null },
        { name: "甲" },
        { name: "乙", lastActive: "2026-08-01T00:00:00.000Z" },
        { name: "丙", lastActive: "2026-07-01T00:00:00.000Z" },
      ]),
    ).toEqual(["新", "乙", "丙", "旧"]);
  });
});

describe("search notices and hits", () => {
  test("joins keyword, stale, and unique warnings into one line", () => {
    const lines = searchNoticeLines(
      {
        indexStatus: "stale",
        searchMode: "keyword",
        warnings: [{ message: "嵌入模型还没就绪" }, { message: "  " }, { message: "嵌入模型还没就绪" }],
      },
      { keyword: "关键词", stale: "过期" },
    );
    expect(lines).toEqual(["关键词", "过期", "嵌入模型还没就绪"]);
    expect(joinNotice(lines)).toBe("关键词 · 过期 · 嵌入模型还没就绪");
    expect(
      searchNoticeLines(
        { indexStatus: "fresh", searchMode: "semantic", warnings: [] },
        { keyword: "关键词", stale: "过期" },
      ),
    ).toEqual([]);
  });

  test("maps the mock scores onto three cells", () => {
    expect(relevanceCells(0.86)).toBe(3);
    expect(relevanceCells(0.75)).toBe(3);
    expect(relevanceCells(0.61)).toBe(2);
    expect(relevanceCells(0.55)).toBe(2);
    expect(relevanceCells(0.44)).toBe(1);
    expect(relevanceCells(0)).toBe(0);
    expect(relevanceCells(Number.NaN)).toBe(0);
    expect(formatScore(0.8)).toBe("0.80");
    expect(formatScore(Number.NaN)).toBe("0.00");
  });

  test("highlights escaped tokens and flattens excerpts", () => {
    expect(highlightParts("住在鸭川东", "鸭川")).toEqual([
      { text: "住在", mark: false },
      { text: "鸭川", mark: true },
      { text: "东", mark: false },
    ]);
    expect(highlightParts("Use Bun", "bun")).toEqual([
      { text: "Use ", mark: false },
      { text: "Bun", mark: true },
    ]);
    expect(highlightParts("a.b", ".")).toEqual([
      { text: "a", mark: false },
      { text: ".", mark: true },
      { text: "b", mark: false },
    ]);
    expect(highlightParts("没有", "设备")).toEqual([{ text: "没有", mark: false }]);
    expect(flattenExcerpt("第一行\n  第二行  ")).toBe("第一行 第二行");
  });
});
