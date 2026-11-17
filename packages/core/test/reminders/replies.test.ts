import { describe, expect, it } from "bun:test";

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REMINDER_REPLY_MAX_LINES,
  createReminderReplyLog,
  readReminderReplies,
} from "../../src/reminders/replies.js";

describe("reminder replies", () => {
  it("写入后能按 reminderId 读回，同一提醒取最新一条", () => {
    const dir = mkdtempSync(join(tmpdir(), "replies-"));
    try {
      const path = join(dir, "reminder-replies.jsonl");
      const write = createReminderReplyLog(path);
      write({ reminderId: "recall:a", topicId: "topic-1", sessionKey: null, text: "先放一放", ts: "2026-11-15T01:00:00.000Z" });
      write({ reminderId: "recall:a", topicId: "topic-1", sessionKey: null, text: "月底再做", ts: "2026-11-16T02:00:00.000Z" });
      write({ reminderId: "recall:b", topicId: null, sessionKey: "s1", text: "知道了", ts: "2026-11-16T03:00:00.000Z" });
      const replies = readReminderReplies(path);
      expect(replies.map((item) => item.reminderId)).toEqual(["recall:a", "recall:b"]);
      expect(replies[0]?.text).toBe("月底再做");
      expect(replies[1]?.topicId).toBeNull();
      expect(replies[1]?.sessionKey).toBe("s1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件不存在返回空数组，坏行跳过", () => {
    expect(readReminderReplies(join(tmpdir(), "no-such-dir", "replies.jsonl"))).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "replies-"));
    try {
      const path = join(dir, "reminder-replies.jsonl");
      const write = createReminderReplyLog(path);
      write({ reminderId: "recall:a", topicId: "t", sessionKey: null, text: "好", ts: "2026-11-15T01:00:00.000Z" });
      appendFileSync(path, "不是 JSON\n");
      appendFileSync(path, `${JSON.stringify({ reminderId: "", text: "没有 id" })}\n`);
      const replies = readReminderReplies(path);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.reminderId).toBe("recall:a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("超过行数上限时只保留最新的行", () => {
    const dir = mkdtempSync(join(tmpdir(), "replies-"));
    try {
      const path = join(dir, "reminder-replies.jsonl");
      const write = createReminderReplyLog(path);
      for (let index = 0; index < REMINDER_REPLY_MAX_LINES + 5; index += 1) {
        write({
          reminderId: `recall:${index}`,
          topicId: "t",
          sessionKey: null,
          text: `第 ${index} 条`,
          ts: new Date(Date.UTC(2026, 10, 15, 0, 0, index)).toISOString(),
        });
      }
      const replies = readReminderReplies(path);
      expect(replies).toHaveLength(REMINDER_REPLY_MAX_LINES);
      expect(replies.at(-1)?.reminderId).toBe(`recall:${REMINDER_REPLY_MAX_LINES + 4}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
