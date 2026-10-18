import { describe, expect, it } from "bun:test";

import {
  DEFAULT_ACTIVE_TOPIC_LIMIT,
  DEFAULT_CONSOLIDATE_TIME,
  DEFAULT_DRIVE_ROOT,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_PORTRAIT_SNAPSHOT_PATTERN,
  DEFAULT_SHARED_CONFIG,
  DEFAULT_TIMEZONE,
  parseProtocolFile,
  parseRoles,
  parseSharedConfig,
  resolveWebProcessor,
  PROTOCOL_VERSION,
} from "../src/index.js";

const MAIN = "11111111-1111-4111-8111-111111111111";
const WEB = "22222222-2222-4222-8222-222222222222";

describe("shared config defaults", () => {
  it("fills every product setting except API keys", () => {
    const config = parseSharedConfig({});
    expect(config).toEqual(DEFAULT_SHARED_CONFIG);
    expect(config.drive.root).toBe(DEFAULT_DRIVE_ROOT);
    expect(config.topics.activeLimit).toBe(DEFAULT_ACTIVE_TOPIC_LIMIT);
    expect(config.topics.historyDays).toBe(DEFAULT_HISTORY_DAYS);
    expect(config.refine.idleMinutes).toBe(DEFAULT_IDLE_MINUTES);
    expect(config.capture.keepToolCalls).toBe(false);
    expect(config.capture.includeSubagents).toBe(false);
    expect(config.capture.redact).toBe(true);
    expect(config.capture.sources["gemini-cli"].enabled).toBe(true);
    expect(config.llm).toEqual({ provider: "deepseek", model: "", baseUrl: "" });
    expect(Object.keys(config.llm).sort()).toEqual(["baseUrl", "model", "provider"]);
    expect(config.portrait.variants.map((variant) => variant.id)).toEqual([
      "full",
      "brief",
      "coding",
    ]);
    expect(config.portrait.variants[0]?.path).toBe(
      "digital-twin/JOHN-DIGITAL-TWIN-latest.md",
    );
    expect(config.portrait.variants[1]?.path).toBe(
      "digital-twin/JOHN-DIGITAL-TWIN-latest-brief.md",
    );
    expect(config.portrait.variants[2]?.path).toBe(
      "digital-twin/JOHN-TWIN-coding.md",
    );
    expect(config.portrait.snapshotPattern).toBe(DEFAULT_PORTRAIT_SNAPSHOT_PATTERN);
    expect(config.reminders.notifications).toBe(true);
    expect(config.reminders.morningDigestTime).toBe("08:00");
    expect(config.ui.language).toBe("zh");
    expect(config.integrations.mcpClients).toEqual([]);
  });

  it("returns a fresh object and deep-merges partial input", () => {
    const first = parseSharedConfig({});
    first.topics.activeLimit = 1;
    first.capture.sources.codex.paths.push("/tmp/codex");
    const second = parseSharedConfig({});
    expect(second.topics.activeLimit).toBe(10);
    expect(second.capture.sources.codex.paths).toEqual([]);

    const merged = parseSharedConfig({
      topics: { activeLimit: 4 },
      capture: { sources: { codex: { enabled: false, paths: ["/tmp/codex"] } } },
      llm: { model: "deepseek-chat" },
    });
    expect(merged.topics).toEqual({ activeLimit: 4, historyDays: 30 });
    expect(merged.refine.idleMinutes).toBe(5);
    expect(merged.capture.sources.codex).toEqual({
      enabled: false,
      paths: ["/tmp/codex"],
      include: [],
      exclude: [],
    });
    expect(merged.capture.sources["claude-code"].enabled).toBe(true);
    expect(merged.capture.redact).toBe(true);
    expect(merged.llm).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "",
    });
  });

  it("rejects unsafe limits and unknown providers", () => {
    expect(() => parseSharedConfig({ topics: { activeLimit: 0 } })).toThrow();
    expect(() => parseSharedConfig({ refine: { idleMinutes: -1 } })).toThrow();
    expect(() => parseSharedConfig({ llm: { provider: "unknown" } })).toThrow();
    expect(() => parseSharedConfig({ ui: { language: "fr" } })).toThrow();
    expect(() =>
      parseSharedConfig({ reminders: { morningDigestTime: "25:00" } }),
    ).toThrow();
  });
});

describe("roles", () => {
  it("defaults consolidation to 03:00 in Asia/Shanghai and follows the main device", () => {
    const roles = parseRoles({});
    expect(roles.consolidation).toEqual({
      enabled: false,
      time: DEFAULT_CONSOLIDATE_TIME,
    });
    expect(roles.timezone).toBe(DEFAULT_TIMEZONE);
    expect(roles.mainDevice).toBeNull();
    expect(resolveWebProcessor(roles)).toBeNull();

    const withMain = parseRoles({ mainDevice: MAIN });
    expect(withMain.webProcessor).toBeNull();
    expect(resolveWebProcessor(withMain)).toBe(MAIN);
    expect(resolveWebProcessor(parseRoles({ mainDevice: MAIN, webProcessor: WEB }))).toBe(
      WEB,
    );
  });

  it("rejects an invalid schedule or device id", () => {
    expect(() => parseRoles({ consolidation: { time: "25:00" } })).toThrow();
    expect(() => parseRoles({ mainDevice: "device-1" })).toThrow();
  });
});

describe("protocol file", () => {
  it("accepts the current version only", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(parseProtocolFile({ version: 1 })).toEqual({ version: 1 });
    expect(() => parseProtocolFile({ version: 2 })).toThrow();
    expect(() => parseProtocolFile({})).toThrow();
  });
});
