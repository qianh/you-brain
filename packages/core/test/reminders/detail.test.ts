import { describe, expect, test } from "bun:test";

import { reminderDetail } from "../../src/reminders/detail.js";
import type { TopicBook } from "../../src/topics/types.js";

const book = {
  topics: [
    { topicId: "t1", name: "指挥台流式输出改造" },
    { topicId: "t2", name: "ESP32 Muse 手环固件联调与蓝牙配对问题排查" },
  ],
  sessions: [],
  conclusions: [
    // 东八区 2026-11-02 的结论(UTC 前一天 16:30 起算)
    { conclusionId: "c1", topicId: "t1", sessionKey: "s", text: "用户要求指挥台回答做到与当前对话一样逐字流出；助手决定沿用现有 SSE 通道", ts: "2026-11-02T03:00:00.000Z" },
    { conclusionId: "c2", topicId: "t2", sessionKey: "s", text: "手环配对要先清除旧绑定", ts: "2026-11-02T10:00:00.000Z" },
    // 前一天和当天的不算
    { conclusionId: "c0", topicId: "t1", sessionKey: "s", text: "更早的", ts: "2026-11-01T03:00:00.000Z" },
    { conclusionId: "c3", topicId: "t1", sessionKey: "s", text: "今天的", ts: "2026-11-03T03:00:00.000Z" },
  ],
  todos: [],
  memory: {},
} as unknown as TopicBook;

const digest = {
  reminderId: "morning:2026-11-03",
  kind: "morning_digest",
  text: "昨日结论 2 条：用户要求指挥台回答做到与当前对话一样逐字流出；助手决定…\n未完成待办 430 件。\n建议跟进：ESP32 Muse …、指挥台流式输出改造。",
};

describe("reminderDetail", () => {
  test("晨间摘要:列出昨日结论全文与话题,还原被截短的建议话题全名", () => {
    const detail = reminderDetail({ reminder: digest, book, timeZoneOffsetMinutes: 480 });
    expect(detail).toContain("昨日结论（2 条）");
    // 倒序:新的在前;带全文与话题名
    expect(detail).toContain("1. 手环配对要先清除旧绑定  —— ESP32 Muse 手环固件联调与蓝牙配对问题排查");
    expect(detail).toContain("助手决定沿用现有 SSE 通道  —— 指挥台流式输出改造");
    expect(detail).not.toContain("更早的");
    expect(detail).not.toContain("今天的");
    expect(detail).toContain("· ESP32 Muse 手环固件联调与蓝牙配对问题排查");
    expect(detail).toContain("· 指挥台流式输出改造");
  });

  test("昨日没有结论 / 非摘要 / id 不合法", () => {
    expect(
      reminderDetail({ reminder: { ...digest, reminderId: "morning:2026-12-20" }, book, timeZoneOffsetMinutes: 480 }),
    ).toContain("昨日没有新结论。");
    expect(
      reminderDetail({ reminder: { ...digest, kind: "stale" }, book, timeZoneOffsetMinutes: 480 }),
    ).toBeNull();
    expect(
      reminderDetail({ reminder: { ...digest, reminderId: "weird" }, book, timeZoneOffsetMinutes: 480 }),
    ).toBeNull();
  });
});
