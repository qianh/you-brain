import { describe, expect, test } from "bun:test";

import {
  CORRECTION_SECTION_LIMIT,
  CORRECTION_TEXT_LIMIT,
  correctionAllowsForm,
  correctionCanSubmit,
  correctionCount,
  correctionExcerpt,
  correctionFieldIssue,
  correctionHint,
  correctionStatusParts,
} from "../../../src/pages/portrait/corrections-logic.js";

describe("portrait correction form", () => {
  test("rejects an empty or oversized section and text after trim", () => {
    expect(correctionFieldIssue("  ", "改短")).toBe("section");
    expect(correctionFieldIssue("语气", "  ")).toBe("text");
    expect(correctionFieldIssue("语".repeat(CORRECTION_SECTION_LIMIT + 1), "改短")).toBe("section");
    expect(correctionFieldIssue("语气", "改".repeat(CORRECTION_TEXT_LIMIT + 1))).toBe("text");
    expect(correctionFieldIssue(`  ${"语".repeat(CORRECTION_SECTION_LIMIT)}  `, " 改短 ")).toBeNull();
    expect(correctionCount("  改短  ")).toBe(2);
    expect(correctionCanSubmit("语气", "改短", false)).toBe(true);
    expect(correctionCanSubmit("语气", "改短", true)).toBe(false);
    expect(correctionCanSubmit("", "改短", false)).toBe(false);
  });

  test("selects the hint from whether consolidation is enabled", () => {
    expect(correctionHint(true)).toBe("on");
    expect(correctionHint(false)).toBe("off");
  });

  test("labels pending and applied corrections", () => {
    expect(correctionStatusParts("pending")).toEqual({ key: "pending", version: "" });
    expect(correctionStatusParts("applied", "JOHN-DIGITAL-TWIN-v1.3.4-2026-10-18.md")).toEqual({
      key: "applied",
      version: "v1.3.4",
    });
    expect(correctionStatusParts("applied")).toEqual({ key: "applied", version: "" });
  });

  test("lets only the full variant open the form and clips long text", () => {
    expect(correctionAllowsForm("full")).toBe(true);
    expect(correctionAllowsForm("brief")).toBe(false);
    const text = "改".repeat(160);
    const clipped = correctionExcerpt(text);
    expect(clipped.truncated).toBe(true);
    expect(Array.from(clipped.excerpt)).toHaveLength(140);
    expect(correctionExcerpt("短")).toEqual({ excerpt: "短", truncated: false });
  });
});
