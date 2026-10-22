import { describe, expect, it } from "bun:test";

import { foldEvents } from "../../src/topics/fold.js";
import {
  STALE_MS,
  computeDueReminders,
  dueRemindersForDevice,
  staleText,
  textLength,
  type ComputeDueInput,
} from "../../src/reminders/index.js";
import {
  isoWeekKey,
  localDateKey,
  localParts,
  timeZoneOffsetMinutes,
  weekdayReached,
} from "../../src/reminders/time.js";
import { DAY, KEY_A, KEY_B, KEY_C, at, topicEvents } from "./fixture.js";

const NOW = "2026-10-21T16:30:00.000Z";
const NOW_MS = Date.parse(NOW);

function due(
  events: ComputeDueInput["book"] extends never ? never : Parameters<typeof foldEvents>[0],
  patch: Partial<ComputeDueInput> & { sessionUpdatedAt?: ComputeDueInput["sessionUpdatedAt"] },
) {
  const input: ComputeDueInput = {
    book: foldEvents(events),
    sessionUpdatedAt: patch.sessionUpdatedAt ?? {},
    reminders: patch.reminders ?? [],
    actions: patch.actions ?? [],
    activeLimit: patch.activeLimit ?? 10,
    historyDays: patch.historyDays ?? 30,
    morningDigestTime: patch.morningDigestTime ?? "08:00",
    weeklyReviewDay: patch.weeklyReviewDay ?? 1,
    weeklyReviewTime: patch.weeklyReviewTime ?? "09:00",
    now: patch.now ?? NOW,
    timeZoneOffsetMinutes: patch.timeZoneOffsetMinutes ?? 0,
    ...(patch.mergeLines ? { mergeLines: patch.mergeLines } : {}),
  };
  return computeDueReminders(input);
}

function kinds(items: ReadonlyArray<{ kind: string }>, kind: string): number {
  return items.filter((item) => item.kind === kind).length;
}

describe("computeDueReminders", () => {
  it("triggers stale at 7 days and not at 6 days 23 hours", () => {
    const exactAt = at(NOW_MS - STALE_MS);
    const almostAt = at(NOW_MS - (STALE_MS - 60 * 60 * 1000));
    const earlyAt = at(NOW_MS - STALE_MS + 1);
    const exact = due(
      topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: exactAt }),
      { sessionUpdatedAt: { [KEY_A]: exactAt } },
    );
    const almost = due(
      topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: almostAt }),
      { sessionUpdatedAt: { [KEY_A]: almostAt } },
    );
    const early = due(
      topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: earlyAt }),
      { sessionUpdatedAt: { [KEY_A]: earlyAt } },
    );
    expect(exact.map((item) => item.reminderId)).toContain(`stale:topic:${localDateKey(localParts(Date.parse(exactAt), 0))}`);
    expect(almost.some((item) => item.kind === "stale")).toBe(false);
    expect(early.some((item) => item.kind === "stale")).toBe(false);
    expect(exact.find((item) => item.kind === "stale")?.text).toBe(
      "「方案」已 7 天没有新进展，还有 1 件待办未完成。",
    );
  });

  it("does not remind a topic without an open todo", () => {
    const last = at(NOW_MS - STALE_MS);
    const items = due(topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: last, todos: 0 }), {
      sessionUpdatedAt: { [KEY_A]: last },
    });
    expect(items.some((item) => item.kind === "stale")).toBe(false);
  });

  it("does not issue the same reminder id twice", () => {
    const last = at(NOW_MS - STALE_MS);
    const events = topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: last });
    const first = due(events, { sessionUpdatedAt: { [KEY_A]: last } });
    const stale = first.find((item) => item.kind === "stale");
    expect(stale).toBeDefined();
    const again = due(events, {
      sessionUpdatedAt: { [KEY_A]: last },
      reminders: [
        {
          reminderId: stale?.reminderId ?? "",
          kind: "stale",
          topicId: "topic",
          text: stale?.text ?? "",
          status: "dismissed",
          until: null,
          issuedAt: NOW,
          updatedAt: NOW,
        },
      ],
    });
    expect(again.some((item) => item.reminderId === stale?.reminderId)).toBe(false);
  });

  it("issues one history reminder per topic per ISO week", () => {
    const old = at(NOW_MS - 40 * DAY);
    const events = [
      ...topicEvents({ topicId: "old-a", name: "甲", key: KEY_A, at: old, todos: 2 }),
      ...topicEvents({ topicId: "old-b", name: "乙", key: KEY_B, at: old }),
      ...topicEvents({ topicId: "old-c", name: "丙", key: KEY_C, at: old, todos: 0 }),
    ];
    const sessionUpdatedAt = { [KEY_A]: old, [KEY_B]: old, [KEY_C]: old };
    const week = isoWeekKey(localParts(NOW_MS, 0));
    const first = due(events, { sessionUpdatedAt });
    const history = first.filter((item) => item.kind === "history");
    expect(history.map((item) => item.reminderId).sort()).toEqual([
      `history:old-a:${week}`,
      `history:old-b:${week}`,
    ]);
    expect(history.find((item) => item.topicId === "old-a")?.text).toContain("2 件待办");
    const kept = history.map((item) => ({
      reminderId: item.reminderId,
      kind: item.kind,
      topicId: item.topicId,
      text: item.text,
      status: "open",
      until: null,
      issuedAt: NOW,
      updatedAt: NOW,
    }));
    const second = due(events, { sessionUpdatedAt, reminders: kept });
    expect(second.some((item) => item.kind === "history")).toBe(false);
    const nextWeek = at(NOW_MS + 7 * DAY);
    const later = due(events, { sessionUpdatedAt, reminders: kept, now: nextWeek });
    const nextKey = isoWeekKey(localParts(Date.parse(nextWeek), 0));
    expect(nextKey).not.toBe(week);
    expect(later.map((item) => item.reminderId)).toContain(`history:old-a:${nextKey}`);
  });

  it("issues the morning digest once, and only after the local time", () => {
    const early = due([], { now: "2026-10-21T07:59:00.000Z", morningDigestTime: "08:00" });
    expect(kinds(early, "morning_digest")).toBe(0);
    const onTime = due([], { now: "2026-10-21T08:00:00.000Z", morningDigestTime: "08:00" });
    expect(onTime.map((item) => item.reminderId)).toContain("morning:2026-10-21");
    const kept = onTime
      .filter((item) => item.kind === "morning_digest")
      .map((item) => ({
        reminderId: item.reminderId,
        kind: item.kind,
        topicId: item.topicId,
        text: item.text,
        status: "open",
        until: null,
        issuedAt: "2026-10-21T08:00:00.000Z",
        updatedAt: "2026-10-21T08:00:00.000Z",
      }));
    const again = due([], {
      now: "2026-10-21T18:00:00.000Z",
      morningDigestTime: "08:00",
      reminders: kept,
    });
    expect(again.some((item) => item.reminderId === "morning:2026-10-21")).toBe(false);
  });

  it("waits for the weekly review weekday and time", () => {
    const parts = localParts(NOW_MS, 0);
    const old = at(NOW_MS - 40 * DAY);
    const events = topicEvents({ topicId: "old", name: "旧题", key: KEY_A, at: old });
    const before = due(events, {
      sessionUpdatedAt: { [KEY_A]: old },
      weeklyReviewDay: parts.isoWeekday,
      weeklyReviewTime: "18:00",
    });
    expect(before.some((item) => item.kind === "weekly_review" || item.kind === "history")).toBe(
      false,
    );
    const after = due(events, {
      sessionUpdatedAt: { [KEY_A]: old },
      weeklyReviewDay: parts.isoWeekday,
      weeklyReviewTime: "16:30",
    });
    expect(after.some((item) => item.kind === "weekly_review")).toBe(true);
    expect(after.some((item) => item.kind === "history")).toBe(true);
    const weekly = after.find((item) => item.kind === "weekly_review");
    expect(weekly?.reminderId).toBe(`weekly:${isoWeekKey(parts)}`);
    expect(weekly?.text).not.toContain("相似话题");
    expect(weekly?.text).toContain("本周活跃话题");
  });

  it("lists up to three merge suggestions and keeps the weekly id", () => {
    const parts = localParts(NOW_MS, 0);
    const events = topicEvents({ topicId: "old", name: "旧题", key: KEY_A, at: at(NOW_MS - 40 * DAY) });
    const lines = [
      { fromName: "甲", intoName: "乙", reason: "重复" },
      { fromName: "丙", intoName: "丁", reason: "同一件" },
      { fromName: "戊", intoName: "己", reason: "重叠" },
      { fromName: "庚", intoName: "辛", reason: "多余" },
    ];
    const after = due(events, {
      sessionUpdatedAt: { [KEY_A]: at(NOW_MS - 40 * DAY) },
      weeklyReviewDay: parts.isoWeekday,
      weeklyReviewTime: "16:30",
      mergeLines: lines,
    });
    const weekly = after.find((item) => item.kind === "weekly_review");
    expect(weekly?.reminderId).toBe(`weekly:${isoWeekKey(parts)}`);
    expect(weekly?.text).toContain("甲 与 乙 看起来是同一件事（重复）。");
    expect(weekly?.text).toContain("戊 与 己 看起来是同一件事（重叠）。");
    expect(weekly?.text).not.toContain("庚");
  });

  it("changes the digest date and yesterday across offsets", () => {
    const events = topicEvents({
      topicId: "topic",
      name: "方案",
      key: KEY_A,
      at: at(NOW_MS - 2 * DAY),
      conclusions: [{ id: "c1", text: "跨日结论", ts: "2026-10-20T10:00:00.000Z" }],
    });
    const sessionUpdatedAt = { [KEY_A]: at(NOW_MS - 2 * DAY) };
    const utc = due(events, {
      sessionUpdatedAt,
      morningDigestTime: "00:00",
      weeklyReviewDay: 7,
      weeklyReviewTime: "23:00",
    });
    const shanghai = due(events, {
      sessionUpdatedAt,
      timeZoneOffsetMinutes: 480,
      morningDigestTime: "00:00",
      weeklyReviewDay: 7,
      weeklyReviewTime: "23:00",
    });
    expect(utc.map((item) => item.reminderId)).toContain("morning:2026-10-21");
    expect(shanghai.map((item) => item.reminderId)).toContain("morning:2026-10-22");
    expect(utc.find((item) => item.kind === "morning_digest")?.text).toContain("跨日结论");
    expect(shanghai.find((item) => item.kind === "morning_digest")?.text).not.toContain("跨日结论");

    const partsUtc = localParts(NOW_MS, 0);
    const partsEast = localParts(NOW_MS, 480);
    expect(partsUtc.isoWeekday).not.toBe(partsEast.isoWeekday);
    expect(weekdayReached(partsUtc, partsUtc.isoWeekday, "18:00")).toBe(false);
    expect(weekdayReached(partsEast, partsUtc.isoWeekday, "18:00")).toBe(true);
    const weeklyUtc = due([], {
      morningDigestTime: "23:59",
      weeklyReviewDay: partsUtc.isoWeekday,
      weeklyReviewTime: "18:00",
    });
    const weeklyEast = due([], {
      timeZoneOffsetMinutes: 480,
      morningDigestTime: "23:59",
      weeklyReviewDay: partsUtc.isoWeekday,
      weeklyReviewTime: "18:00",
    });
    expect(kinds(weeklyUtc, "weekly_review")).toBe(0);
    expect(kinds(weeklyEast, "weekly_review")).toBe(1);
    const earlyEast = due([], {
      timeZoneOffsetMinutes: 480,
      morningDigestTime: "08:00",
      weeklyReviewDay: 7,
      weeklyReviewTime: "23:59",
    });
    expect(kinds(earlyEast, "morning_digest")).toBe(0);
    expect(timeZoneOffsetMinutes("Asia/Shanghai", new Date(NOW))).toBe(480);
    expect(timeZoneOffsetMinutes("UTC", new Date(NOW))).toBe(0);
    expect(isoWeekKey(localParts(Date.parse("2021-01-01T00:00:00.000Z"), 0))).toBe("2020-W53");
    expect(isoWeekKey(localParts(Date.parse("2026-01-08T00:00:00.000Z"), 0))).toBe("2026-W02");
  });

  it("suggests open-todo topics, preferring recent stale and follow-up", () => {
    const events = [
      ...topicEvents({
        topicId: "follow",
        name: "跟进",
        key: KEY_A,
        at: at(NOW_MS - DAY),
        status: "follow_up",
      }),
      ...topicEvents({
        topicId: "stale",
        name: "停滞",
        key: KEY_B,
        at: at(NOW_MS - 10 * DAY),
      }),
      ...topicEvents({
        topicId: "plain",
        name: "普通",
        key: KEY_C,
        at: at(NOW_MS - 2 * DAY),
        conclusions: [{ id: "c-y", text: "记下了", ts: "2026-10-20T03:00:00.000Z" }],
      }),
    ];
    const items = due(events, {
      sessionUpdatedAt: {
        [KEY_A]: at(NOW_MS - DAY),
        [KEY_B]: at(NOW_MS - 10 * DAY),
        [KEY_C]: at(NOW_MS - 2 * DAY),
      },
      morningDigestTime: "08:00",
      weeklyReviewDay: 7,
      weeklyReviewTime: "23:59",
    });
    const digest = items.find((item) => item.kind === "morning_digest");
    expect(digest?.topicId).toBeNull();
    expect(digest?.text).toContain("昨日结论：记下了");
    expect(digest?.text).toContain("未完成待办 3 件。");
    expect(digest?.text).toContain("建议跟进：跟进、停滞、普通。");
    for (const line of digest?.text.split("\n") ?? []) {
      expect(textLength(line)).toBeLessThanOrEqual(80);
    }
    expect(textLength(digest?.text ?? "")).toBeLessThanOrEqual(200);
  });

  it("keeps reminder text inside the length limits", () => {
    const longName = "名".repeat(80);
    const last = at(NOW_MS - STALE_MS);
    const items = due(
      topicEvents({
        topicId: "topic",
        name: longName,
        key: KEY_A,
        at: last,
        conclusions: [{ id: "long", text: "结".repeat(100), ts: "2026-10-20T01:00:00.000Z" }],
      }),
      { sessionUpdatedAt: { [KEY_A]: last }, weeklyReviewDay: 7, weeklyReviewTime: "23:59" },
    );
    for (const item of items) {
      expect(textLength(item.text)).toBeLessThanOrEqual(200);
      for (const line of item.text.split("\n")) expect(textLength(line)).toBeLessThanOrEqual(80);
    }
    expect(staleText("   ", 1)).toContain("未命名话题");
  });

  it("lets only the main device generate, and ignores the notification flag", () => {
    const last = at(NOW_MS - STALE_MS);
    const events = topicEvents({ topicId: "topic", name: "方案", key: KEY_A, at: last });
    const base = {
      deviceId: "device-a",
      mainDevice: "device-a" as string | null,
      notifications: false,
      events,
      sessionUpdatedAt: { [KEY_A]: last },
      activeLimit: 10,
      historyDays: 30,
      morningDigestTime: "08:00",
      weeklyReviewDay: 7,
      weeklyReviewTime: "23:59",
      now: NOW,
      timeZoneOffsetMinutes: 0,
    };
    const issued = dueRemindersForDevice(base);
    expect(issued.some((item) => item.kind === "stale")).toBe(true);
    expect(dueRemindersForDevice({ ...base, notifications: true })).toEqual(issued);
    expect(dueRemindersForDevice({ ...base, mainDevice: "device-b" })).toEqual([]);
    expect(dueRemindersForDevice({ ...base, mainDevice: null })).toEqual([]);
  });
});
