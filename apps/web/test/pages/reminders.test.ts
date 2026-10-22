import { describe, expect, test } from "bun:test";

import {
  isDigestReminder,
  reminderFailureMessage,
  reminderFirstLine,
  snoozeUntil,
} from "../../src/pages/reminders/model.js";

describe("snoozeUntil", () => {
  test("uses 09:00 on the local calendar day", () => {
    const evening = new Date("2026-10-23T15:30:00.000Z");
    expect(snoozeUntil(evening, "Asia/Shanghai", 1)).toBe("2026-10-24T01:00:00.000Z");
    expect(snoozeUntil(evening, "Asia/Shanghai", 3)).toBe("2026-10-26T01:00:00.000Z");
    expect(snoozeUntil(evening, "Asia/Shanghai", 7)).toBe("2026-10-30T01:00:00.000Z");
    expect(snoozeUntil(evening, "UTC", 1)).toBe("2026-10-24T09:00:00.000Z");
  });

  test("steps from the local date when UTC is already the next day", () => {
    const afterMidnight = new Date("2026-10-23T16:30:00.000Z");
    expect(snoozeUntil(afterMidnight, "Asia/Shanghai", 1)).toBe("2026-10-25T01:00:00.000Z");
  });

  test("recomputes the offset across a daylight-saving change", () => {
    const beforeSpring = new Date("2026-03-08T02:30:00.000Z");
    expect(snoozeUntil(beforeSpring, "America/New_York", 1)).toBe("2026-03-08T13:00:00.000Z");
  });
});

describe("reminder text", () => {
  test("keeps the first line and notices a continuation", () => {
    expect(reminderFirstLine("早报\n昨天有 4 段会话。")).toEqual({
      line: "早报",
      more: true,
    });
    expect(reminderFirstLine("单行提醒")).toEqual({ line: "单行提醒", more: false });
  });

  test("treats a digest or a reminder without a topic as read-only", () => {
    expect(isDigestReminder({ kind: "morning_digest", topicId: null })).toBe(true);
    expect(isDigestReminder({ kind: "weekly_review", topicId: "topic-1" })).toBe(true);
    expect(isDigestReminder({ kind: "stale", topicId: null })).toBe(true);
    expect(isDigestReminder({ kind: "stale", topicId: "topic-1" })).toBe(false);
    expect(isDigestReminder({ kind: "history", topicId: "topic-1" })).toBe(false);
  });

  test("uses the error message when an action fails", () => {
    expect(reminderFailureMessage(new Error("这条提醒只能关闭"), "操作没有完成")).toBe("这条提醒只能关闭");
    expect(reminderFailureMessage(new Error("  "), "操作没有完成")).toBe("操作没有完成");
    expect(reminderFailureMessage("nope", "操作没有完成")).toBe("操作没有完成");
  });
});
