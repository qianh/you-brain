import { describe, expect, it } from "bun:test";

import { describeSchedule, describeExecutor, taskDueMs } from "../../src/deck/tasks.js";

const TZ = "Asia/Shanghai";
// 2026-10-31 12:00 +08:00 = 04:00 UTC
const NOON = Date.parse("2026-10-31T04:00:00.000Z");
// 2026-10-31 06:00 +08:00 = 22:00 UTC（10-30）
const SIX_AM = Date.parse("2026-10-30T22:00:00.000Z");

describe("deck tasks due logic", () => {
  it("daily task before its time is not due", () => {
    expect(
      taskDueMs({ schedule: { kind: "daily", time: "08:00" }, lastRunAt: null }, SIX_AM, TZ),
    ).toBeNull();
  });

  it("daily task past its time and never run is due at today's occurrence", () => {
    const due = taskDueMs({ schedule: { kind: "daily", time: "08:00" }, lastRunAt: null }, NOON, TZ);
    expect(due).toBe(Date.parse("2026-10-31T00:00:00.000Z"));
  });

  it("daily task already run today is not due again", () => {
    expect(
      taskDueMs(
        { schedule: { kind: "daily", time: "08:00" }, lastRunAt: "2026-10-31T00:05:00.000Z" },
        NOON,
        TZ,
      ),
    ).toBeNull();
  });

  it("daily task catches up once when yesterday's run was missed", () => {
    expect(
      taskDueMs(
        { schedule: { kind: "daily", time: "08:00" }, lastRunAt: "2026-10-30T00:05:00.000Z" },
        NOON,
        TZ,
      ),
    ).toBe(Date.parse("2026-10-31T00:00:00.000Z"));
  });

  it("interval task runs when the window elapsed", () => {
    const schedule = { kind: "interval" as const, minutes: 30 };
    expect(taskDueMs({ schedule, lastRunAt: null }, NOON, TZ)).toBe(NOON);
    // 03:25 → 04:00 是 35 分钟 ≥ 30。
    expect(
      taskDueMs({ schedule, lastRunAt: "2026-10-31T03:25:00.000Z" }, NOON, TZ),
    ).toBe(NOON);
    // 03:45 → 15 分钟，未到。
    expect(
      taskDueMs({ schedule, lastRunAt: "2026-10-31T03:45:00.000Z" }, NOON, TZ),
    ).toBeNull();
  });

  it("describes schedules and executors in Chinese", () => {
    expect(describeSchedule({ kind: "daily", time: "08:00" })).toBe("每天 08:00");
    expect(describeSchedule({ kind: "interval", minutes: 90 })).toBe("每 90 分钟");
    expect(describeSchedule({ kind: "interval", minutes: 120 })).toBe("每 2 小时");
    expect(describeExecutor({ kind: "cli-agent", id: "claude-cli" })).toBe("本机 agent claude-cli");
    expect(describeExecutor({ kind: "gui-app", id: "grok-bot" })).toBe("App grok-bot");
  });
});
