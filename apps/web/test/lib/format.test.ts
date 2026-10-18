import { describe, expect, test } from "bun:test";

import {
  deviceLabel,
  driveFileUrl,
  formatDateTime,
  formatDay,
  LLM_PROVIDER_IDS,
  providerNeedsKey,
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
