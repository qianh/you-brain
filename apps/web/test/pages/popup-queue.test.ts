import { describe, expect, test } from "bun:test";
import type { DeckSessionNotice, ReminderView } from "@you-brain/core/http/types.js";

import { buildPopupQueue, formatTerminalSnippet } from "../../src/pages/popup-queue.js";

function reminder(id: string, issuedAt: string, overrides: Partial<ReminderView> = {}): ReminderView {
  return {
    reminderId: id,
    kind: "recall",
    status: "open",
    topicId: "t1",
    topicName: "话题",
    text: `提醒 ${id}`,
    until: null,
    issuedAt,
    sessionKey: null,
    reply: null,
    ...overrides,
  };
}

function notice(seq: number, at: string, overrides: Partial<DeckSessionNotice> = {}): DeckSessionNotice {
  return {
    seq,
    pane: 7,
    kind: "waiting",
    status: "open",
    sessionName: "you-brain",
    agent: "Claude",
    cwd: "/Users/hong/John/ai/you-brain",
    title: "you-brain 在等你回复",
    body: "确认继续吗？",
    at,
    ...overrides,
  };
}

describe("buildPopupQueue", () => {
  test("merges open recall reminders and open terminal notices in newest-first order", () => {
    const queue = buildPopupQueue(
      [
        reminder("r-old", "2026-11-18T08:00:00.000Z"),
        reminder("r-closed", "2026-11-18T08:05:00.000Z", { status: "done" }),
        reminder("r-digest", "2026-11-18T08:06:00.000Z", { kind: "morning_digest" }),
        reminder("r-new", "2026-11-18T08:04:00.000Z"),
      ],
      [
        notice(1, "2026-11-18T08:02:00.000Z"),
        notice(2, "2026-11-18T08:07:00.000Z", { status: "closed" }),
        notice(3, "2026-11-18T08:08:00.000Z", { kind: "done", title: "you-brain 已完成", body: "" }),
      ],
    );
    expect(queue.map((item) => item.key)).toEqual([
      "terminal:3",
      "reminder:r-new",
      "terminal:1",
      "reminder:r-old",
    ]);
  });
});

describe("formatTerminalSnippet", () => {
  test("strips ANSI escapes, drops blank lines, and keeps the last N lines", () => {
    const raw = [
      "",
      "\x1b[32m✓\x1b[0m line 1",
      "line 2   ",
      "",
      "line 3",
      "line 4",
      "Continue? [y/N]   ",
      "",
    ].join("\n");
    expect(formatTerminalSnippet(raw, 3)).toBe(["line 3", "line 4", "Continue? [y/N]"].join("\n"));
    expect(formatTerminalSnippet("   \n\n  ")).toBe("");
  });
});
