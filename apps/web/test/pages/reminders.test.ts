import { describe, expect, test } from "bun:test";

import {
  isDigestReminder,
  isRecallReminder,
  parseDigest,
  parseDigestDetail,
  reminderFailureMessage,
  reminderFirstLine,
  snoozeUntil,
} from "../../src/pages/reminders/model.js";
// 契约:卡片按 core 拼出的早报句式解析,core 改了文案这里会先红。
import { digestText } from "../../../../packages/core/src/reminders/text.js";

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

describe("recall reminders", () => {
  test("both the loud and the quiet kind count as recall", () => {
    expect(isRecallReminder({ kind: "recall" })).toBe(true);
    expect(isRecallReminder({ kind: "recall_quiet" })).toBe(true);
    expect(isRecallReminder({ kind: "stale" })).toBe(false);
    expect(isRecallReminder({ kind: "morning_digest" })).toBe(false);
  });

  test("a recall reminder carries a topic, so it keeps the topic actions", () => {
    expect(isDigestReminder({ kind: "recall", topicId: "topic-1" })).toBe(false);
    expect(isDigestReminder({ kind: "recall_quiet", topicId: "topic-1" })).toBe(false);
  });
});

describe("parseDigest / parseDigestDetail", () => {
  test("reads counts and follow-up names from the text core writes, dropping the clipped first conclusion", () => {
    const text = digestText({
      conclusions: ["等待8分钟阻塞监测数据的后台命令已完成，退出码为0；本次没有异常", "第二条"],
      openTodoCount: 727,
      suggestions: ["ChatGPT订阅计费", "货代产品能力", "海运运价预测"],
    });
    expect(parseDigest(text)).toEqual({
      conclusions: 2,
      todos: 727,
      suggestions: ["ChatGPT订阅计费", "货代产品能力", "海运运价预测"],
    });
    expect(parseDigest(digestText({ conclusions: ["一条"], openTodoCount: 0, suggestions: [] }))).toEqual({
      conclusions: 1,
      todos: 0,
      suggestions: [],
    });
    expect(parseDigest(digestText({ conclusions: [], openTodoCount: 3, suggestions: [] }))?.conclusions).toBe(0);
  });

  test("returns null for text it does not recognise, so the card falls back to the raw text", () => {
    expect(parseDigest("早报\n昨天有 4 段会话。")).toBeNull();
  });

  test("splits the detail into conclusions with their topics and full follow-up names", () => {
    const detail = [
      "昨日结论（61 条）",
      "1. 后台命令已完成，退出码为 0  —— 阻塞监测",
      "2. 没有话题的结论",
      "……还有 1 条较早的结论,在话题册里查看。",
      "",
      "建议跟进",
      "· 货代产品能力评估",
    ].join("\n");
    expect(parseDigestDetail(detail)).toEqual({
      conclusions: [
        { text: "后台命令已完成，退出码为 0", topic: "阻塞监测" },
        { text: "没有话题的结论", topic: null },
      ],
      note: "还有 1 条较早的结论,在话题册里查看。",
      suggestions: ["货代产品能力评估"],
    });
    expect(parseDigestDetail("别的格式")).toBeNull();
  });
});
