import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { outputCopy } from "../../src/output/copy.js";
import { renderReminders } from "../../src/output/render.js";
import {
  computeDueReminders,
  foldReminders,
  planReminderAction,
  presentReminders,
  reminderActions,
} from "../../src/reminders/index.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { foldEvents } from "../../src/topics/fold.js";
import { persistTopicBook } from "../../src/topics/persist.js";
import {
  DAY,
  KEY_A,
  actionEvent,
  at,
  issuedEvents,
  reminderRecord,
  topicEvents,
} from "./fixture.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");

function runDue(events: Parameters<typeof foldEvents>[0], now: string, sessionUpdatedAt: Record<string, string>) {
  return computeDueReminders({
    book: foldEvents(events),
    sessionUpdatedAt,
    reminders: foldReminders(events),
    actions: reminderActions(events),
    activeLimit: 10,
    historyDays: 30,
    morningDigestTime: "08:00",
    weeklyReviewDay: 1,
    weeklyReviewTime: "09:00",
    now,
    timeZoneOffsetMinutes: 0,
  });
}

function staleOf(events: Parameters<typeof foldEvents>[0], now: string, sessionUpdatedAt: Record<string, string>) {
  return runDue(events, now, sessionUpdatedAt).filter((item) => item.kind === "stale");
}

describe("foldReminders", () => {
  it("folds actions into statuses and keeps an earlier action when the issue arrives later", () => {
    const issued = issuedEvents(
      [{ reminderId: "stale:topic:2026-01-01", kind: "stale", topicId: "topic", text: "该跟进了" }],
      "2026-01-08T00:00:00.000Z",
    );
    const snoozed = actionEvent({
      reminderId: "stale:topic:2026-01-01",
      topicId: "topic",
      action: "snooze",
      ts: "2026-01-08T01:00:00.000Z",
      until: "2026-01-18T00:00:00.000Z",
    });
    const folded = foldReminders([...issued, snoozed]);
    expect(folded).toEqual([
      {
        reminderId: "stale:topic:2026-01-01",
        kind: "stale",
        topicId: "topic",
        text: "该跟进了",
        status: "snoozed",
        until: "2026-01-18T00:00:00.000Z",
        issuedAt: "2026-01-08T00:00:00.000Z",
        updatedAt: "2026-01-08T01:00:00.000Z",
      },
    ]);
    const reversed = foldReminders([
      actionEvent({
        reminderId: "stale:topic:2026-01-01",
        topicId: "topic",
        action: "snooze",
        ts: "2026-01-07T00:00:00.000Z",
        until: "2026-01-18T00:00:00.000Z",
      }),
      ...issued,
    ]);
    expect(reversed[0]).toMatchObject({
      status: "snoozed",
      until: "2026-01-18T00:00:00.000Z",
      kind: "stale",
      text: "该跟进了",
    });
    expect(
      foldReminders([
        ...issued,
        actionEvent({
          reminderId: "stale:topic:2026-01-01",
          topicId: "topic",
          action: "reactivate",
          ts: "2026-01-09T00:00:00.000Z",
        }),
      ])[0]?.status,
    ).toBe("done");
  });

  it("shows an expired snooze as open and hides a future one", () => {
    const topics = [{ topicId: "topic", name: "方案", mergedInto: null }];
    const open = reminderRecord({
      reminderId: "stale:topic:2026-01-01",
      kind: "stale",
      topicId: "topic",
      status: "snoozed",
      until: "2026-01-18T00:00:00.000Z",
      issuedAt: "2026-01-08T00:00:00.000Z",
    });
    const later = reminderRecord({
      reminderId: "stale:topic:2026-01-02",
      kind: "stale",
      topicId: "topic",
      status: "snoozed",
      until: "2026-02-01T00:00:00.000Z",
      issuedAt: "2026-01-09T00:00:00.000Z",
    });
    const dismissed = reminderRecord({
      reminderId: "morning:2026-01-08",
      kind: "morning_digest",
      topicId: null,
      status: "dismissed",
      issuedAt: "2026-01-10T00:00:00.000Z",
    });
    const now = "2026-01-18T00:00:00.000Z";
    expect(presentReminders([open, later, dismissed], now, topics, false).map((item) => item.reminderId)).toEqual([
      "stale:topic:2026-01-01",
    ]);
    expect(presentReminders([open], now, topics, false)[0]?.status).toBe("open");
    const all = presentReminders([open, later, dismissed], now, topics, true);
    expect(all.map((item) => item.status)).toEqual(["dismissed", "snoozed", "open"]);
    expect(all.map((item) => item.issuedAt)).toEqual([
      "2026-01-10T00:00:00.000Z",
      "2026-01-09T00:00:00.000Z",
      "2026-01-08T00:00:00.000Z",
    ]);
  });

  it("follows a merged topic name", () => {
    const view = presentReminders(
      [
        reminderRecord({
          reminderId: "stale:old:2026-01-01",
          kind: "stale",
          topicId: "old",
          status: "open",
        }),
      ],
      "2026-01-08T00:00:00.000Z",
      [
        { topicId: "old", name: "旧名", mergedInto: "live" },
        { topicId: "live", name: "新名", mergedInto: null },
      ],
      false,
    );
    expect(view[0]?.topicName).toBe("新名");
  });

  it("stops after three ignores, and another action clears the streak", () => {
    let events = topicEvents({
      topicId: "topic",
      name: "方案",
      key: KEY_A,
      at: at(START),
    });
    const sessions = { [KEY_A]: at(START) };
    for (let week = 1; week <= 3; week += 1) {
      const now = at(START + week * 7 * DAY);
      const due = staleOf(events, now, sessions);
      expect(due).toHaveLength(1);
      const item = due[0];
      if (!item) throw new Error("missing stale reminder");
      events = [...events, ...issuedEvents([item], now), actionEvent({
        reminderId: item.reminderId,
        topicId: item.topicId,
        action: "ignore",
        ts: now,
      })];
    }
    expect(staleOf(events, at(START + 4 * 7 * DAY), sessions)).toEqual([]);

    let reset = topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: at(START) });
    for (let week = 1; week <= 2; week += 1) {
      const now = at(START + week * 7 * DAY);
      const due = staleOf(reset, now, sessions);
      const item = due[0];
      if (!item) throw new Error("missing stale reminder");
      reset = [...reset, ...issuedEvents([item], now), actionEvent({
        reminderId: item.reminderId,
        topicId: item.topicId,
        action: "ignore",
        ts: now,
      })];
    }
    const snoozeAt = at(START + 3 * 7 * DAY);
    const beforeSnooze = staleOf(reset, snoozeAt, sessions);
    const pending = beforeSnooze[0];
    if (!pending) throw new Error("missing reminder before snooze");
    reset = [
      ...reset,
      ...issuedEvents([pending], snoozeAt),
      actionEvent({
        reminderId: pending.reminderId,
        topicId: pending.topicId,
        action: "snooze",
        ts: snoozeAt,
        until: at(START + 3 * 7 * DAY + DAY),
      }),
    ];
    expect(staleOf(reset, at(START + 3 * 7 * DAY + 2 * DAY), sessions)).toEqual([]);
    const resumedAt = at(START + 4 * 7 * DAY);
    const resumed = staleOf(reset, resumedAt, sessions);
    expect(resumed.map((item) => item.reminderId)).toEqual(["stale:topic:2026-01-22"]);
    const resumedItem = resumed[0];
    if (!resumedItem) throw new Error("missing resumed reminder");
    reset = [
      ...reset,
      ...issuedEvents([resumedItem], resumedAt),
      actionEvent({
        reminderId: resumedItem.reminderId,
        topicId: resumedItem.topicId,
        action: "ignore",
        ts: resumedAt,
      }),
    ];
    expect(staleOf(reset, at(START + 5 * 7 * DAY), sessions)).toHaveLength(1);
  });

  it("hides a topic while snoozed and can issue a new id after the snooze ends", () => {
    let events = topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: at(START) });
    const sessions = { [KEY_A]: at(START) };
    const issuedAt = at(START + 7 * DAY);
    const first = staleOf(events, issuedAt, sessions);
    expect(first.map((item) => item.reminderId)).toEqual(["stale:topic:2026-01-01"]);
    const item = first[0];
    if (!item) throw new Error("missing reminder");
    events = [
      ...events,
      ...issuedEvents([item], issuedAt),
      actionEvent({
        reminderId: item.reminderId,
        topicId: item.topicId,
        action: "snooze",
        ts: issuedAt,
        until: "2026-01-18T00:00:00.000Z",
      }),
    ];
    expect(staleOf(events, "2026-01-16T00:00:00.000Z", sessions)).toEqual([]);
    expect(staleOf(events, "2026-01-18T00:00:00.000Z", sessions).map((entry) => entry.reminderId)).toEqual([
      "stale:topic:2026-01-08",
    ]);
  });

  it("mutes until the topic is active again", () => {
    let events = topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: at(START) });
    const issuedAt = at(START + 7 * DAY);
    const first = staleOf(events, issuedAt, { [KEY_A]: at(START) });
    const item = first[0];
    if (!item) throw new Error("missing reminder");
    events = [
      ...events,
      ...issuedEvents([item], issuedAt),
      actionEvent({
        reminderId: item.reminderId,
        topicId: "topic",
        action: "mute",
        ts: issuedAt,
      }),
    ];
    expect(staleOf(events, at(START + 14 * DAY), { [KEY_A]: at(START) })).toEqual([]);
    const revived = "2026-01-16T00:00:00.000Z";
    expect(staleOf(events, revived, { [KEY_A]: revived })).toEqual([]);
    expect(
      staleOf(events, "2026-01-23T00:00:00.000Z", { [KEY_A]: revived }).map((entry) => entry.reminderId),
    ).toEqual(["stale:topic:2026-01-16"]);
  });

  it("replays the same events into the same reminder rows on two devices", () => {
    const dir = mkdtempSync(join(tmpdir(), "you-brain-reminders-"));
    const left = new SqliteStore(join(dir, "a.sqlite"));
    const right = new SqliteStore(join(dir, "b.sqlite"));
    try {
      const base = topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: at(START) });
      const issued = issuedEvents(
        [{ reminderId: "stale:topic:2026-01-01", kind: "stale", topicId: "topic", text: "该跟进了" }],
        at(START + 7 * DAY),
      );
      const action = actionEvent({
        reminderId: "stale:topic:2026-01-01",
        topicId: "topic",
        action: "ignore",
        ts: at(START + 7 * DAY + 1000),
      });
      const events = [...base, ...issued, action];
      persistTopicBook(left, foldEvents(events));
      persistTopicBook(right, foldEvents([...events].reverse()));
      expect(left.listReminders()).toEqual(right.listReminders());
      expect(foldReminders(events)).toEqual(foldReminders([...events].reverse()));

      left.upsertReminder(
        reminderRecord({
          reminderId: "kept",
          kind: "stale",
          topicId: "topic",
          status: "open",
        }),
      );
      left.replaceDerived({
        topics: [],
        sessions: [],
        conclusions: [],
        todos: [],
        events: [],
      });
      expect(left.listReminders().some((item) => item.reminderId === "kept")).toBe(true);
      left.replaceDerived({
        topics: [],
        sessions: [],
        conclusions: [],
        todos: [],
        events: [],
        reminders: [],
      });
      expect(left.listReminders()).toEqual([]);
    } finally {
      left.close();
      right.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("planReminderAction", () => {
  const digest = {
    reminderId: "morning:2026-10-21",
    kind: "morning_digest",
    topicId: null,
    topicName: null,
    text: "早报",
    status: "open",
    until: null,
    issuedAt: "2026-10-21T08:00:00.000Z",
  };

  it("allows only ignore on a digest", () => {
    const refused = planReminderAction({
      reminder: digest,
      action: "snooze",
      until: null,
      now: "2026-10-21T09:00:00.000Z",
    });
    expect(refused).toEqual({
      error: { status: 400, code: "INVALID_INPUT", message: "这条提醒只能关闭" },
    });
    const closed = planReminderAction({
      reminder: digest,
      action: "ignore",
      until: "2026-10-22T00:00:00.000Z",
      now: "2026-10-21T09:00:00.000Z",
    });
    if ("error" in closed) throw new Error(closed.error.message);
    expect(closed.events.map((event) => event.type)).toEqual(["reminder.action"]);
    expect(closed.events[0]?.data).toMatchObject({ action: "ignore", topicId: null, until: null });
    expect(closed.reminder.status).toBe("dismissed");
  });

  it("reactivates or finishes the topic and snoozes for one day by default", () => {
    const reminder = {
      reminderId: "stale:topic:2026-10-14",
      kind: "stale",
      topicId: "topic",
      topicName: "方案",
      text: "该跟进了",
      status: "open",
      until: null,
      issuedAt: "2026-10-21T08:00:00.000Z",
    };
    const now = "2026-10-21T16:30:00.000Z";
    const reactivated = planReminderAction({
      reminder,
      action: "reactivate",
      until: null,
      now,
    });
    if ("error" in reactivated) throw new Error(reactivated.error.message);
    expect(reactivated.events.map((event) => event.type)).toEqual([
      "topic.status_changed",
      "reminder.action",
    ]);
    expect(reactivated.events[0]).toMatchObject({
      type: "topic.status_changed",
      data: { topicId: "topic", status: "active", by: "user" },
    });
    expect(reactivated.reminder.status).toBe("done");
    const done = planReminderAction({ reminder, action: "done", until: null, now });
    if ("error" in done) throw new Error(done.error.message);
    expect(done.events[0]).toMatchObject({
      data: { status: "done", by: "user" },
    });
    const snoozed = planReminderAction({ reminder, action: "snooze", until: null, now });
    if ("error" in snoozed) throw new Error(snoozed.error.message);
    expect(snoozed.reminder).toMatchObject({
      status: "snoozed",
      until: "2026-10-22T16:30:00.000Z",
    });
    expect(planReminderAction({ reminder, action: "ignore", until: null, now: "nope" })).toEqual({
      error: { status: 400, code: "INVALID_INPUT", message: "时间无效" },
    });
  });
});

describe("REMINDERS.md", () => {
  it("groups the current reminders and keeps the empty copy", () => {
    const zh = outputCopy("zh");
    const en = outputCopy("en");
    expect(renderReminders(zh, [])).toBe("# 提醒\n\n暂无提醒\n");
    expect(renderReminders(en, [])).toBe("# Reminders\n\nNo reminders yet\n");
    const rendered = renderReminders(zh, [
      { kind: "weekly_review", text: "回顾一行" },
      { kind: "morning_digest", text: "早报一行\n早报二行" },
      { kind: "stale", text: "跟进甲" },
      { kind: "history", text: "跟进乙" },
    ]);
    expect(rendered).toBe(`# 提醒

## 待跟进话题

跟进甲

跟进乙

## 今日早报

早报一行
早报二行

## 本周回顾

回顾一行
`);
    expect(renderReminders(en, [{ kind: "morning_digest", text: "Digest" }])).toBe(`# Reminders

## Morning digest

Digest
`);
  });
});
