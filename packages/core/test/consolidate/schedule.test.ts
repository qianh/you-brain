import { describe, expect, it } from "bun:test";

import { INTERVALS } from "../../src/daemon/schedule.js";
import {
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  consolidationBlock,
  consolidationTimeDue,
  localDayKey,
  nextBackoffMs,
  planConsolidationDays,
} from "../../src/consolidate/schedule.js";
import { PITCAIRN, SHANGHAI } from "./fixture.js";

describe("consolidation schedule", () => {
  it("checks about every 10 minutes", () => {
    expect(INTERVALS.consolidationMs).toBe(10 * 60_000);
  });

  it("is due only after the local clock reaches the configured time", () => {
    const instant = new Date("2026-10-23T12:30:00.000Z");
    expect(consolidationTimeDue(instant, SHANGHAI, "20:00")).toBe(true);
    expect(consolidationTimeDue(instant, PITCAIRN, "20:00")).toBe(false);
    expect(consolidationTimeDue(new Date("2026-10-23T11:59:00.000Z"), SHANGHAI, "20:00")).toBe(
      false,
    );
    expect(consolidationTimeDue(new Date("2026-10-23T12:00:00.000Z"), SHANGHAI, "20:00")).toBe(
      true,
    );
  });

  it("uses the IANA zone for the calendar day", () => {
    const instant = new Date("2026-10-23T04:00:00.000Z");
    expect(localDayKey(instant, SHANGHAI)).toBe("2026-10-23");
    expect(localDayKey(instant, PITCAIRN)).toBe("2026-10-22");
  });

  it("treats an invalid time zone as not due", () => {
    expect(consolidationTimeDue(new Date("2026-10-23T12:30:00.000Z"), "Not/AZone", "03:00")).toBe(
      false,
    );
  });

  it("plans today only when there is no lease", () => {
    expect(planConsolidationDays({ leaseDate: null, today: "2026-10-23" })).toEqual([
      "2026-10-23",
    ]);
    expect(planConsolidationDays({ leaseDate: "bad", today: "2026-10-23" })).toEqual([
      "2026-10-23",
    ]);
  });

  it("catches up in date order and stops at seven days", () => {
    expect(
      planConsolidationDays({ leaseDate: "2026-10-20", today: "2026-10-23" }),
    ).toEqual(["2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(planConsolidationDays({ leaseDate: "2026-10-01", today: "2026-10-23" })).toEqual([
      "2026-10-17",
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(planConsolidationDays({ leaseDate: "2026-02-01", today: "2026-03-01" })).toEqual([
      "2026-02-23",
      "2026-02-24",
      "2026-02-25",
      "2026-02-26",
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
  });

  it("skips a day another device already finished, unless forced", () => {
    expect(planConsolidationDays({ leaseDate: "2026-10-23", today: "2026-10-23" })).toEqual([]);
    expect(
      planConsolidationDays({ leaseDate: "2026-10-23", today: "2026-10-23", force: true }),
    ).toEqual(["2026-10-23"]);
    expect(planConsolidationDays({ leaseDate: "2026-10-24", today: "2026-10-23" })).toEqual([]);
    expect(
      planConsolidationDays({ leaseDate: "2026-10-24", today: "2026-10-23", force: true }),
    ).toEqual(["2026-10-23"]);
  });

  it("checks the main device before the switch, the model, and the drive", () => {
    expect(
      consolidationBlock({
        deviceId: "a",
        mainDevice: null,
        enabled: false,
        hasLlm: false,
        hasDrive: false,
      }),
    ).toBe("NOT_MAIN_DEVICE");
    expect(
      consolidationBlock({
        deviceId: "a",
        mainDevice: "b",
        enabled: true,
        hasLlm: true,
        hasDrive: true,
      }),
    ).toBe("NOT_MAIN_DEVICE");
    expect(
      consolidationBlock({
        deviceId: "a",
        mainDevice: "a",
        enabled: false,
        hasLlm: true,
        hasDrive: true,
      }),
    ).toBe("DISABLED");
    expect(
      consolidationBlock({
        deviceId: "a",
        mainDevice: "a",
        enabled: true,
        hasLlm: false,
        hasDrive: true,
      }),
    ).toBe("NO_LLM");
    expect(
      consolidationBlock({
        deviceId: "a",
        mainDevice: "a",
        enabled: true,
        hasLlm: true,
        hasDrive: false,
      }),
    ).toBe("NO_DRIVE");
    expect(
      consolidationBlock({
        deviceId: "a",
        mainDevice: "a",
        enabled: true,
        hasLlm: true,
        hasDrive: true,
      }),
    ).toBeNull();
  });

  it("backs off from 30 minutes and caps at 6 hours", () => {
    expect(nextBackoffMs(0)).toBe(BACKOFF_INITIAL_MS);
    expect(nextBackoffMs(BACKOFF_INITIAL_MS)).toBe(60 * 60_000);
    expect(nextBackoffMs(BACKOFF_MAX_MS)).toBe(BACKOFF_MAX_MS);
    expect(BACKOFF_INITIAL_MS).toBe(30 * 60_000);
    expect(BACKOFF_MAX_MS).toBe(6 * 60 * 60_000);
  });
});
