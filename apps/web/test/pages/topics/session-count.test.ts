import { describe, expect, test } from "bun:test";

import { listSessionCount } from "../../../src/pages/topics/session-count.js";

describe("topic list session count", () => {
  test("uses the list field on every row, including zero", () => {
    const idle = { topicId: "idle", sessionCount: 0 };
    const busy = { topicId: "busy", sessionCount: 3 };
    expect(listSessionCount(idle, "busy", 9)).toBe(0);
    expect(listSessionCount(busy, null, null)).toBe(3);
  });

  test("falls back to the open topic's detail when an older daemon omits the field", () => {
    expect(listSessionCount({ topicId: "open" }, "open", 4)).toBe(4);
    expect(listSessionCount({ topicId: "other" }, "open", 4)).toBe(null);
    expect(listSessionCount({ topicId: "open" }, "open", null)).toBe(null);
  });

  test("ignores a non-count and keeps the detail fallback", () => {
    const blank = { topicId: "open", sessionCount: undefined };
    const negative = { topicId: "open", sessionCount: -1 };
    const text = { topicId: "open", sessionCount: "4" };
    expect(listSessionCount(blank, "open", 2)).toBe(2);
    expect(listSessionCount(negative, "open", 2)).toBe(2);
    expect(listSessionCount(text, "open", 2)).toBe(2);
  });
});
