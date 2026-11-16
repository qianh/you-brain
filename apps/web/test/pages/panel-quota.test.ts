import { describe, expect, test } from "bun:test";
import type { QuotaAccount } from "@you-brain/core/http/types.js";

import { quotaCards, quotaTone, resetIn, windowLabel } from "../../src/pages/panel/quota.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const recent = (ms: number): string => new Date(NOW - ms).toISOString();

const claude: QuotaAccount = {
  agent: "claude",
  plan: "pro",
  active: true,
  windows: [
    { name: "5 hours", used: 31, resetsAt: "2026-11-16T16:00:00Z" },
    { name: "7 days", used: 54, resetsAt: null },
  ],
};
const grok: QuotaAccount = { agent: "grok", plan: null, active: true, windows: [{ name: "7 days", used: 2, resetsAt: null }] };

describe("quotaCards", () => {
  test("shows only agents whose source captured something in the last 7 days", () => {
    const cards = quotaCards(
      [claude, grok],
      [
        { source: "claude-code", lastCaptureAt: recent(DAY) },
        { source: "grok-build", lastCaptureAt: recent(8 * DAY) },
      ],
      NOW,
      "zh",
    );
    expect(cards.map((card) => card.agent)).toEqual(["claude"]);
    expect(cards[0]?.label).toBe("Claude Code");
    expect(cards[0]?.plan).toBe("pro");
    expect(cards[0]?.windows.map((window) => [window.label, window.used, window.tone])).toEqual([
      ["5 小时", 31, "ok"],
      ["7 天", 54, "ok"],
    ]);
  });

  test("a source captured exactly 7 days ago still counts; one captured just over does not", () => {
    const at = (ms: number) => quotaCards([claude], [{ source: "claude-code", lastCaptureAt: recent(ms) }], NOW, "zh");
    expect(at(7 * DAY)).toHaveLength(1);
    expect(at(7 * DAY + 1)).toHaveLength(0);
  });

  test("hides agents never captured, with no capture time, or when captures are missing", () => {
    expect(quotaCards([claude], [{ source: "claude-code", lastCaptureAt: null }], NOW, "zh")).toEqual([]);
    expect(quotaCards([claude], [], NOW, "zh")).toEqual([]);
    expect(quotaCards([claude], undefined, NOW, "zh")).toEqual([]);
  });

  test("ignores agents it has no source for", () => {
    const kiro: QuotaAccount = { agent: "kiro", plan: null, active: true, windows: [{ name: "x", used: 1, resetsAt: null }] };
    expect(quotaCards([kiro], [{ source: "kiro", lastCaptureAt: recent(0) }], NOW, "zh")).toEqual([]);
  });

  test("with several accounts for one agent it uses the active one", () => {
    const other: QuotaAccount = { ...claude, plan: "max", active: false };
    const cards = quotaCards([other, claude], [{ source: "claude-code", lastCaptureAt: recent(0) }], NOW, "zh");
    expect(cards[0]?.plan).toBe("pro");
    expect(quotaCards([other], [{ source: "claude-code", lastCaptureAt: recent(0) }], NOW, "zh")).toEqual([]);
  });

  test("keeps a fixed order, not magpie's", () => {
    const captures = [
      { source: "claude-code", lastCaptureAt: recent(0) },
      { source: "grok-build", lastCaptureAt: recent(0) },
    ];
    expect(quotaCards([grok, claude], captures, NOW, "zh").map((card) => card.agent)).toEqual(["claude", "grok"]);
  });
});

describe("quotaTone", () => {
  test.each([
    [0, "ok"],
    [79.9, "ok"],
    [80, "warn"],
    [94.9, "warn"],
    [95, "danger"],
    [100, "danger"],
  ] as const)("%d%% is %s", (used, tone) => {
    expect(quotaTone(used)).toBe(tone);
  });
});

describe("windowLabel", () => {
  test("translates hours and days in Chinese and keeps a model suffix", () => {
    expect(windowLabel("5 hours", "zh")).toBe("5 小时");
    expect(windowLabel("7 days", "zh")).toBe("7 天");
    expect(windowLabel("7 days · Fable", "zh")).toBe("7 天 · Fable");
    expect(windowLabel("30 days", "zh")).toBe("30 天");
  });
  test("leaves English and unknown names alone", () => {
    expect(windowLabel("5 hours", "en")).toBe("5 hours");
    expect(windowLabel("MCP Month", "zh")).toBe("MCP Month");
  });
});

describe("resetIn", () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  test("counts down in minutes, hours, days", () => {
    expect(resetIn(at(30_000), NOW, "zh")).toBe("1 分钟后");
    expect(resetIn(at(45 * 60_000), NOW, "zh")).toBe("45 分钟后");
    expect(resetIn(at(4 * 3_600_000 + 5 * 60_000), NOW, "zh")).toBe("4 小时后");
    expect(resetIn(at(2 * DAY + 3_600_000), NOW, "zh")).toBe("2 天后");
    expect(resetIn(at(4 * 3_600_000), NOW, "en")).toBe("in 4h");
  });
  test("is null when missing, unparseable, or already past", () => {
    expect(resetIn(null, NOW, "zh")).toBeNull();
    expect(resetIn("soon", NOW, "zh")).toBeNull();
    expect(resetIn(at(-1000), NOW, "zh")).toBeNull();
    expect(resetIn(at(0), NOW, "zh")).toBeNull();
  });
});
