import { describe, expect, test } from "bun:test";
import type { QuotaAccount, QuotaTokenUsage, QuotaView } from "@you-brain/core/http/types.js";

import {
  minutesAgo,
  quotaCards as buildQuotaCards,
  quotaOptions,
  quotaSelection,
  quotaTone,
  resetIn,
  shortWindowLabel,
  tokenCount,
  windowLabel,
  type QuotaCaptures,
} from "../../src/pages/panel/quota.js";
import type { Language } from "../../src/lib/format.js";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const recent = (ms: number): string => new Date(NOW - ms).toISOString();

const READ = "2026-11-16T11:59:00Z";
const claude: QuotaAccount = {
  id: "c1",
  readAt: READ,
  stale: false,
  agent: "claude",
  plan: "pro",
  active: true,
  windows: [
    { name: "5 hours", used: 31, resetsAt: "2026-11-16T16:00:00Z" },
    { name: "7 days", used: 54, resetsAt: null },
  ],
};
const grok: QuotaAccount = { id: "g1", readAt: READ, stale: false, agent: "grok", plan: null, active: true, windows: [{ name: "7 days", used: 2, resetsAt: null }] };
const cursor: QuotaAccount = { id: "cursor-test", readAt: READ, stale: false, agent: "cursor", plan: "pro", active: true,
  windows: [{ name: "30 days", used: 42, resetsAt: "2026-12-01T00:00:00Z" }] };
const codexTokens: QuotaTokenUsage = {
  today: { calls: 12, input: 9537980, output: 1386395, cacheRead: 170604150, total: 181528525 },
  threeDays: { calls: 40, input: 13177456, output: 1670765, cacheRead: 261297792, total: 276146013 },
  sevenDays: { calls: 3100, input: 16977456, output: 1670765, cacheRead: 321297792, total: 339946013 },
};
const view = (
  accounts: QuotaAccount[],
  tokens: Record<string, QuotaTokenUsage> = {},
): Pick<QuotaView, "accounts" | "tokens"> => ({ accounts, tokens });
const captured = (source: string): Array<{ source: string; lastCaptureAt: string | null }> => [{ source, lastCaptureAt: recent(0) }];
const quotaCards = (quota: Parameters<typeof buildQuotaCards>[0], captures: QuotaCaptures, nowMs: number, language: Language) =>
  buildQuotaCards(quota, quotaSelection(null, captures, nowMs), nowMs, language);

describe("quota selection", () => {
  test("defaults to recent capture sources, including Cursor", () => {
    expect([...quotaSelection(null, captured("cursor"), NOW)]).toEqual(["cursor"]);
    expect([...quotaSelection("not-json", captured("cursor"), NOW)]).toEqual(["cursor"]);
  });

  test("an explicit selection overrides activity including when all items are unchecked", () => {
    expect([...quotaSelection('["cursor","cursor","retired",1]', captured("claude-code"), NOW)]).toEqual(["cursor", "retired"]);
    expect([...quotaSelection("[]", captured("claude-code"), NOW)]).toEqual([]);
    expect(buildQuotaCards(view([claude]), quotaSelection("[]", captured("claude-code"), NOW), NOW, "zh")).toEqual([]);
  });

  test("shows selected Cursor subscription data without a capture, never a placeholder quota", () => {
    const selected = quotaSelection('["cursor"]', undefined, NOW);
    const cards = buildQuotaCards(view([claude, cursor]), selected, NOW, "zh");
    expect(cards.map((card) => card.label)).toEqual(["Cursor"]);
    expect(cards[0]?.windows[0]).toMatchObject({ used: 42, resetsAt: "2026-12-01T00:00:00Z", label: "30 天" });
    expect(buildQuotaCards(view([claude, { ...cursor, windows: [] }]), selected, NOW, "zh")).toEqual([]);
  });
});

describe("quotaCards", () => {
  test("shows only agents whose source captured something in the last 7 days", () => {
    const cards = quotaCards(
      view([claude, grok]),
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
    expect(cards[0]?.tokens).toBeUndefined();
  });

  test("gives Codex a token card with the three spans when it has no subscription", () => {
    const cards = quotaCards(view([], { codex: codexTokens }), captured("codex"), NOW, "zh");
    expect(cards.map((card) => card.agent)).toEqual(["codex"]);
    expect(cards[0]?.label).toBe("Codex");
    expect(cards[0]?.windows).toEqual([]);
    expect(cards[0]?.tokens?.today.total).toBe(181528525);
    expect(cards[0]?.tokens?.threeDays.total).toBe(276146013);
    expect(cards[0]?.tokens?.sevenDays.total).toBe(339946013);
    expect(cards[0]?.stale).toBe(false);
  });

  test("shows Codex token card when sessions were captured only via t3-code", () => {
    const cards = quotaCards(view([], { codex: codexTokens }), captured("t3-code"), NOW, "zh");
    expect(cards.map((card) => card.agent)).toEqual(["codex"]);
    expect(cards[0]?.tokens?.today.total).toBe(181528525);
  });

  test("a subscription card carries token spans alongside its windows", () => {
    const cards = quotaCards(view([claude], { claude: codexTokens }), captured("claude-code"), NOW, "zh");
    expect(cards[0]?.tokens?.sevenDays.calls).toBe(3100);
  });

  test("tokenCount formats millions, thousands and raw counts", () => {
    expect(tokenCount(339946013)).toBe("339.9M");
    expect(tokenCount(181528525)).toBe("181.5M");
    expect(tokenCount(17_500)).toBe("18K");
    expect(tokenCount(842)).toBe("842");
  });

  test("a subscription card keeps its own stale mark", () => {
    const staleClaude: QuotaAccount = { ...claude, stale: true, readAt: "2026-11-16T11:52:00Z" };
    expect(quotaCards(view([staleClaude]), captured("claude-code"), NOW, "zh")[0]?.stale).toBe(true);
  });

  test("a subscription beats token-only presentation when Codex has both", () => {
    const codexSub: QuotaAccount = { id: "x1", readAt: READ, stale: false, agent: "codex", plan: "plus", active: true, windows: [{ name: "5 hours", used: 10, resetsAt: null }] };
    const cards = quotaCards(view([codexSub], { codex: codexTokens }), captured("codex"), NOW, "zh");
    expect(cards[0]?.plan).toBe("plus");
    expect(cards[0]?.windows).toHaveLength(1);
    expect(cards[0]?.tokens?.sevenDays.total).toBe(339946013);
  });

  test("a source captured exactly 7 days ago still counts; one captured just over does not", () => {
    const at = (ms: number) => quotaCards(view([claude]), [{ source: "claude-code", lastCaptureAt: recent(ms) }], NOW, "zh");
    expect(at(7 * DAY)).toHaveLength(1);
    expect(at(7 * DAY + 1)).toHaveLength(0);
  });

  test("hides agents never captured, with no capture time, or when captures are missing", () => {
    expect(quotaCards(view([claude]), [{ source: "claude-code", lastCaptureAt: null }], NOW, "zh")).toEqual([]);
    expect(quotaCards(view([claude]), [], NOW, "zh")).toEqual([]);
    expect(quotaCards(view([claude]), undefined, NOW, "zh")).toEqual([]);
  });

  test("hides an agent with neither a subscription nor token usage, and shows nothing without quota data", () => {
    expect(quotaCards(view([]), captured("codex"), NOW, "zh")).toEqual([]);
    expect(quotaCards(null, captured("claude-code"), NOW, "zh")).toEqual([]);
  });

  test("ignores agents it has no source for", () => {
    const kiro: QuotaAccount = { id: "k1", readAt: READ, stale: false, agent: "kiro", plan: null, active: true, windows: [{ name: "x", used: 1, resetsAt: null }] };
    expect(quotaCards(view([kiro]), [{ source: "kiro", lastCaptureAt: recent(0) }], NOW, "zh")).toEqual([]);
  });

  test("with several accounts for one agent it uses the active one", () => {
    const other: QuotaAccount = { ...claude, id: "c2", plan: "max", active: false };
    const cards = quotaCards(view([other, claude]), captured("claude-code"), NOW, "zh");
    expect(cards[0]?.plan).toBe("pro");
    expect(quotaCards(view([other]), captured("claude-code"), NOW, "zh")).toEqual([]);
  });

  test("carries an account's stale mark and read time onto its card", () => {
    const old: QuotaAccount = { ...claude, stale: true, readAt: "2026-11-16T11:52:00Z" };
    const cards = quotaCards(view([old]), captured("claude-code"), NOW, "zh");
    expect(cards[0]?.stale).toBe(true);
    expect(minutesAgo(cards[0]?.readAt ?? "", NOW)).toBe(8);
  });

  test("keeps a fixed order, not magpie's", () => {
    const captures = [
      { source: "claude-code", lastCaptureAt: recent(0) },
      { source: "grok-build", lastCaptureAt: recent(0) },
    ];
    expect(quotaCards(view([grok, claude]), captures, NOW, "zh").map((card) => card.agent)).toEqual(["claude", "grok"]);
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

describe("shortWindowLabel", () => {
  test("shortens hours and days for the top bar and keeps a model suffix", () => {
    expect(shortWindowLabel("5 hours")).toBe("5h");
    expect(shortWindowLabel("7 days")).toBe("7d");
    expect(shortWindowLabel("1 day")).toBe("1d");
    expect(shortWindowLabel("7 days · Fable")).toBe("7d Fable");
    expect(shortWindowLabel("MCP Month")).toBe("MCP Month");
  });
});

describe("nextQuotaIndex", () => {
  test("steps through the models and wraps round", async () => {
    const { nextQuotaIndex } = await import("../../src/components/quota-strip.js");
    expect([0, 1, 2].map((index) => nextQuotaIndex(index, 3))).toEqual([1, 2, 0]);
    expect(nextQuotaIndex(0, 1)).toBe(0);
    expect(nextQuotaIndex(4, 0)).toBe(0);
  });
});

describe("quotaOptions", () => {
  test("lists what magpie returns: known agents first, unknown by id, hidden ones dropped", () => {
    const mk = (agent: string, windows = [{ name: "7 days", used: 1, resetsAt: null }], active = true): QuotaAccount =>
      ({ id: agent, readAt: READ, stale: false, agent, plan: null, active, windows });
    const options = quotaOptions(view(
      [mk("zcode"), mk("newtool"), mk("copilot"), mk("grok"), mk("gemini", []), mk("cursor", undefined, false)],
      { codex: codexTokens },
    ));
    expect(options).toEqual([
      { agent: "codex", label: "Codex" },
      { agent: "grok", label: "Grok" },
      { agent: "zcode", label: "ZCode" },
      { agent: "newtool", label: "newtool" },
    ]);
    expect(quotaOptions(null)).toEqual([]);
  });

  test("an unknown agent that is checked shows a card straight away", () => {
    const tool: QuotaAccount = { id: "n1", readAt: READ, stale: false, agent: "newtool", plan: null, active: true, windows: [{ name: "7 days", used: 5, resetsAt: null }] };
    const cards = buildQuotaCards(view([tool]), new Set(["newtool"]), NOW, "zh");
    expect(cards.map((card) => [card.agent, card.label])).toEqual([["newtool", "newtool"]]);
  });

  test("agents found on this machine are listed even when magpie has nothing for them", () => {
    const options = quotaOptions({ ...view([]), local: ["claude", "kimi", "copilot", "cursor"] });
    expect(options).toEqual([
      { agent: "claude", label: "Claude Code" },
      { agent: "cursor", label: "Cursor" },
      { agent: "kimi", label: "Kimi CLI" },
    ]);
  });

  test("a ticked agent with no numbers still gets an empty card straight away", () => {
    const cards = buildQuotaCards({ ...view([]), local: ["cursor"] }, new Set(["cursor"]), NOW, "zh");
    expect(cards).toEqual([{ agent: "cursor", label: "Cursor", plan: null, stale: false, readAt: null, windows: [] }]);
  });
});
