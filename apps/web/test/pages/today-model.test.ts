import { describe, expect, test } from "bun:test";

import {
  arrivedKeys,
  formatCount,
  formatTodayHeading,
  groupSessionsByHour,
  guideSteps,
  foldGuideSteps,
  guideSummary,
  joinGuideNames,
  readTodayMode,
  summarizeToday,
  topicZone,
  writeTodayMode,
  type ModeStorage,
} from "../../src/pages/today/model.js";

function memory(initial?: Record<string, string>): ModeStorage {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("today mode storage", () => {
  test("defaults to topic and remembers time", () => {
    const store = memory();
    expect(readTodayMode(null)).toBe("topic");
    expect(readTodayMode(store)).toBe("topic");
    writeTodayMode(store, "time");
    expect(readTodayMode(store)).toBe("time");
    writeTodayMode(null, "time");
  });

  test("ignores storage failures", () => {
    const broken: ModeStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readTodayMode(broken)).toBe("topic");
    expect(() => writeTodayMode(broken, "time")).not.toThrow();
  });
});

describe("formatTodayHeading", () => {
  test("adds the long weekday", () => {
    expect(formatTodayHeading("2026-10-21", "zh")).toContain("2026年10月21日");
    expect(formatTodayHeading("2026-10-21", "zh")).toContain("星期三");
    const english = formatTodayHeading("2026-10-21", "en");
    expect(english).toContain("Wednesday");
    expect(english).toContain("Oct 21, 2026");
  });

  test("returns an invalid date unchanged", () => {
    expect(formatTodayHeading("yesterday", "zh")).toBe("yesterday");
  });
});

describe("formatCount", () => {
  test("groups thousands", () => {
    expect(formatCount(1200, "en")).toBe("1,200");
    expect(formatCount(1200, "zh")).toBe("1,200");
  });
});

describe("summarizeToday", () => {
  test("counts sources, topics, and open todos", () => {
    const stats = summarizeToday([
      {
        source: "claude",
        topicId: "design",
        todos: [{ status: "open" }, { status: "done" }, { status: "dropped" }],
      },
      { source: "claude", topicId: null, todos: [{ status: "open" }] },
      { source: "", topicId: "trip", todos: [] },
    ]);
    expect(stats).toEqual({
      sessions: 3,
      sources: 1,
      topics: 2,
      unassigned: 1,
      openTodos: 2,
      doneTodos: 1,
    });
  });
});

describe("guideSteps", () => {
  test("fresh install leaves every step open", () => {
    const steps = guideSteps({
      driveReachable: null,
      warnings: [{ code: "LLM_NOT_CONFIGURED" }],
      sessionCount: 0,
      lastSyncAt: null,
    });
    expect(steps.map((step) => step.done)).toEqual([false, false, false]);
    expect(steps.map((step) => step.section)).toEqual(["account", "model", "integrations"]);
    expect(guideSummary(steps)).toEqual({ done: 0, total: 3, visible: true });
  });

  test("completes each step from status and today only", () => {
    const driveDown = guideSteps({
      driveReachable: false,
      warnings: [{ code: "SEARCH_STALE" }],
      sessionCount: 0,
      lastSyncAt: "2026-10-21T08:00:00+08:00",
    });
    expect(driveDown.map((step) => step.done)).toEqual([false, true, true]);

    const captured = guideSteps({
      driveReachable: true,
      warnings: [{ code: "LLM_OTHER" }],
      sessionCount: 2,
      lastSyncAt: null,
    });
    expect(captured.map((step) => step.done)).toEqual([true, false, true]);

    const done = guideSteps({
      driveReachable: true,
      warnings: [],
      sessionCount: 0,
      lastSyncAt: "2026-10-21T08:00:00+08:00",
    });
    expect(done.every((step) => step.done)).toBe(true);
    expect(guideSummary(done).visible).toBe(false);
  });

  test("collapses finished steps into a summary while one step is still open", () => {
    const fresh = guideSteps({
      driveReachable: null,
      warnings: [{ code: "LLM_NOT_CONFIGURED" }],
      sessionCount: 0,
      lastSyncAt: null,
    });
    expect(foldGuideSteps(fresh)).toEqual({ done: [], pending: fresh, collapsed: false });

    const half = guideSteps({
      driveReachable: true,
      warnings: [],
      sessionCount: 0,
      lastSyncAt: null,
    });
    const fold = foldGuideSteps(half);
    expect(fold.collapsed).toBe(true);
    expect(fold.done.map((step) => step.id)).toEqual(["drive", "model"]);
    expect(fold.pending.map((step) => step.id)).toEqual(["capture"]);
    expect(joinGuideNames(["Google Drive", "模型"], "、")).toBe("Google Drive、模型");
    expect(joinGuideNames(["Google Drive", "Model"], ", ")).toBe("Google Drive, Model");

    const done = half.map((step) => ({ ...step, done: true }));
    expect(foldGuideSteps(done).collapsed).toBe(false);
    expect(guideSummary(done).visible).toBe(false);
  });
});

describe("groupSessionsByHour", () => {
  const zone = "Asia/Shanghai";

  test("buckets local hours and keeps unknown times last", () => {
    const groups = groupSessionsByHour(
      [
        { sessionKey: "late", updatedAt: "2026-10-21T23:30:00+08:00" },
        { sessionKey: "early", updatedAt: "2026-10-21T08:10:00+08:00" },
        { sessionKey: "newer", updatedAt: "2026-10-21T16:40:00+08:00" },
        { sessionKey: "older", updatedAt: "2026-10-21T16:05:00+08:00" },
        { sessionKey: "none", updatedAt: null },
        { sessionKey: "bad", updatedAt: "not-a-time", startedAt: null },
      ],
      zone,
      "时间不明",
    );
    expect(groups.map((group) => group.label)).toEqual([
      "23:00 – 00:00",
      "16:00 – 17:00",
      "08:00 – 09:00",
      "时间不明",
    ]);
    expect(groups[1]?.sessions.map((session) => session.sessionKey)).toEqual(["newer", "older"]);
    expect(groups[3]?.sessions.map((session) => session.sessionKey)).toEqual(["bad", "none"]);
  });
});

describe("arrivedKeys", () => {
  test("highlights nothing on the first observation", () => {
    expect(arrivedKeys(null, ["a"])).toEqual([]);
    expect(arrivedKeys(new Set(["a"]), ["a", "b"])).toEqual(["b"]);
  });
});

describe("topicZone", () => {
  test("falls back to active", () => {
    expect(topicZone([{ topicId: "old", zone: "history" }], "old")).toBe("history");
    expect(topicZone([], "missing")).toBe("active");
  });
});
