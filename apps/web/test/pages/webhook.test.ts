import { describe, expect, test } from "bun:test";

import { webhookSaveBody, webhookUrlIssue } from "../../src/pages/settings/webhook-logic.js";

describe("webhook save body", () => {
  test("omits the secret to keep it, sends an empty string to clear, and sends a new value to replace", () => {
    const base = {
      enabled: true,
      url: "  https://hooks.example/you-brain  ",
      events: ["topic.merged", "reminder.issued", "reminder.issued"] as const,
    };
    expect(webhookSaveBody({ ...base, secretMode: "keep", secret: "ignored" })).toEqual({
      enabled: true,
      url: "https://hooks.example/you-brain",
      events: ["reminder.issued", "topic.merged"],
    });
    expect(webhookSaveBody({ ...base, secretMode: "clear", secret: "ignored" }).secret).toBe("");
    expect(webhookSaveBody({ ...base, secretMode: "replace", secret: "" })).not.toHaveProperty("secret");
    expect(webhookSaveBody({ ...base, secretMode: "replace", secret: "next" }).secret).toBe("next");
  });

  test("rejects userinfo, non-http URLs, and over-long URLs, and allows an empty URL only when disabled", () => {
    expect(webhookUrlIssue("https://user:pass@hooks.example/hook", false)).toBe("userinfo");
    expect(webhookUrlIssue("ftp://hooks.example/hook", false)).toBe("invalid");
    expect(webhookUrlIssue(`https://hooks.example/${"a".repeat(2048)}`, false)).toBe("long");
    expect(webhookUrlIssue("", false)).toBeNull();
    expect(webhookUrlIssue("  ", true)).toBe("required");
    expect(webhookUrlIssue("https://hooks.example/hook", true)).toBeNull();
  });
});
