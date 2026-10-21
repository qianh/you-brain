import { describe, expect, test } from "bun:test";

import {
  deviceLabel,
  driveFileUrl,
  formatDateTime,
  formatDay,
  LLM_PROVIDER_IDS,
  providerNeedsKey,
  formatRelative,
  sourceLabel,
  variantName,
  weekdayName,
} from "../../src/lib/format.js";

describe("formatDateTime", () => {
  test("formats in the requested zone and language", () => {
    const iso = "2026-10-18T01:30:00.000Z";
    const expected = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
    expect(formatDateTime(iso, "zh", "Asia/Shanghai")).toBe(expected);
    expect(formatDateTime(iso, "en", "Asia/Shanghai")).toContain("18");
  });

  test("keeps empty and invalid values readable", () => {
    expect(formatDateTime(null, "zh")).toBe("—");
    expect(formatDateTime("   ", "en")).toBe("—");
    expect(formatDateTime("yesterday", "en")).toBe("yesterday");
  });

  test("falls back when the time zone is unknown", () => {
    expect(formatDateTime("2026-10-18T01:30:00.000Z", "zh", "Not/AZone")).not.toBe("—");
  });
});

describe("formatDay", () => {
  test("renders a calendar date without shifting the day", () => {
    expect(formatDay("2026-10-18", "zh")).toBe("2026年10月18日");
    expect(formatDay("2026-10-18", "en")).toContain("2026");
    expect(formatDay("18 Oct", "zh")).toBe("18 Oct");
  });
});

describe("labels", () => {
  test("resolves sources, devices, variants, and weekdays", () => {
    expect(sourceLabel("claude-code")).toBe("Claude Code");
    expect(sourceLabel("web")).toBe("web");
    expect(deviceLabel("dev-1", [{ deviceId: "dev-1", displayName: "MacBook Air" }])).toBe(
      "MacBook Air",
    );
    expect(deviceLabel("missing", [])).toBe("missing");
    expect(variantName("coding", "zh")).toBe("编码");
    expect(variantName("coding", "en")).toBe("Coding");
    expect(variantName("custom", "zh")).toBe("custom");
    expect(weekdayName(1, "zh")).toBe("周一");
    expect(weekdayName(1, "en")).toBe("Monday");
    expect(weekdayName(9, "en")).toBe("9");
    expect(providerNeedsKey("ollama")).toBe(false);
    expect(providerNeedsKey("deepseek")).toBe(true);
    expect(providerNeedsKey("grok-cli")).toBe(false);
    expect(providerNeedsKey("kimi")).toBe(true);
    expect(LLM_PROVIDER_IDS).toContain("kimi");
    expect(LLM_PROVIDER_IDS.some((provider) => provider.includes("kimi") && provider !== "kimi")).toBe(
      false,
    );
  });

  test("builds a stable Drive link", () => {
    expect(driveFileUrl("abc/123")).toBe("https://drive.google.com/file/d/abc%2F123/view");
  });
});

describe("formatRelative", () => {
  const zone = "Asia/Shanghai";
  const now = new Date("2026-10-18T02:00:00.000Z");

  test("keeps empty and invalid values readable", () => {
    expect(formatRelative(null, "zh", zone, now)).toBe("—");
    expect(formatRelative("  ", "en", zone, now)).toBe("—");
    expect(formatRelative("yesterday", "en", zone, now)).toBe("yesterday");
  });

  test("says just now inside a minute, including a short future", () => {
    expect(formatRelative("2026-10-18T01:59:20.000Z", "zh", zone, now)).toBe("刚刚");
    expect(formatRelative("2026-10-18T02:00:30.000Z", "en", zone, now)).toBe("Just now");
  });

  test("counts minutes and hours before it crosses a calendar day", () => {
    expect(formatRelative("2026-10-18T01:55:00.000Z", "zh", zone, now)).toBe("5 分钟前");
    expect(formatRelative("2026-10-18T01:59:00.000Z", "en", zone, now)).toBe("1 minute ago");
    expect(formatRelative("2026-10-18T01:30:00.000Z", "en", zone, now)).toBe("30 minutes ago");
    expect(formatRelative("2026-10-17T23:00:00.000Z", "zh", zone, now)).toBe("3 小时前");
    expect(formatRelative("2026-10-17T23:00:00.000Z", "en", zone, now)).toBe("3 hours ago");
  });

  test("keeps a short midnight span in minutes", () => {
    const midnight = new Date("2026-10-17T16:20:00.000Z");
    expect(formatRelative("2026-10-17T15:50:00.000Z", "zh", zone, midnight)).toBe("30 分钟前");
  });

  test("uses yesterday, same-year, and cross-year stamps", () => {
    expect(formatRelative("2026-10-17T08:05:00.000Z", "zh", zone, now)).toBe("昨天 16:05");
    expect(formatRelative("2026-10-17T08:05:00.000Z", "en", zone, now)).toBe("Yesterday 16:05");
    expect(formatRelative("2026-10-01T08:05:00.000Z", "zh", zone, now)).toBe("10月1日 16:05");
    expect(formatRelative("2026-10-01T08:05:00.000Z", "en", zone, now)).toBe("Oct 1, 16:05");
    expect(formatRelative("2025-10-18T08:05:00.000Z", "zh", zone, now)).toBe("2025年10月18日 16:05");
    expect(formatRelative("2025-10-18T08:05:00.000Z", "en", zone, now)).toBe("Oct 18, 2025, 16:05");
  });
});
