import { describe, expect, it } from "bun:test";

import {
  ACTIVITY_FUTURE_SLACK_MS,
  ACTIVITY_PAST_LIMIT_MS,
  acceptActivityAt,
} from "../../src/reminders/activity.js";
import {
  ACTIVITY_EPOCH,
  ACTIVITY_WINDOW_MS,
  activityIsRecent,
  decideDelivery,
  type DeliveryDevice,
} from "../../src/reminders/delivery.js";

const NOW = "2026-10-23T08:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function at(deltaMs: number): string {
  return new Date(NOW_MS + deltaMs).toISOString();
}

function device(deviceId: string, deltaMs: number): DeliveryDevice {
  return { deviceId, lastActiveAt: at(deltaMs) };
}

describe("decideDelivery", () => {
  it("reports disabled before any activity check", () => {
    expect(
      decideDelivery({
        notifications: false,
        deviceId: "local",
        lastActivityAt: NOW,
        devices: [],
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "disabled" });
    expect(
      decideDelivery({
        notifications: false,
        deviceId: "local",
        lastActivityAt: null,
        devices: [device("other", 0)],
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "disabled" });
  });

  it("is inactive when this device has no recent activity", () => {
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: null,
        devices: [],
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "inactive" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: at(-ACTIVITY_WINDOW_MS - 1),
        devices: [],
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "inactive" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: "not-a-time",
        devices: [],
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "inactive" });
  });

  it("notifies when this device is the newest inside the window", () => {
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: at(-ACTIVITY_WINDOW_MS),
        devices: [device("older", -ACTIVITY_WINDOW_MS - 5_000)],
        now: NOW,
      }),
    ).toEqual({ notify: true, reason: "ok" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: NOW,
        devices: [device("stale", -ACTIVITY_WINDOW_MS - 1), device("local", -60_000)],
        now: NOW,
      }),
    ).toEqual({ notify: true, reason: "ok" });
  });

  it("yields when another device is strictly newer and still inside the window", () => {
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: at(-60_000),
        devices: [device("other", -1_000)],
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "other-device" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: at(-60_000),
        devices: [device("old", -ACTIVITY_WINDOW_MS - 1)],
        now: NOW,
      }),
    ).toEqual({ notify: true, reason: "ok" });
  });

  it("breaks a timestamp tie by the smaller device id", () => {
    const tied = [device("a", 0), device("m", 0), device("z", 0)];
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "m",
        lastActivityAt: NOW,
        devices: tied,
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "other-device" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "a",
        lastActivityAt: NOW,
        devices: tied,
        now: NOW,
      }),
    ).toEqual({ notify: true, reason: "ok" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "z",
        lastActivityAt: NOW,
        devices: tied,
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "other-device" });
  });

  it("treats the epoch as inactive even when now is the epoch", () => {
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: ACTIVITY_EPOCH,
        devices: [],
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "inactive" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: ACTIVITY_EPOCH,
        devices: [device("other", 0)],
        now: ACTIVITY_EPOCH,
      }),
    ).toEqual({ notify: false, reason: "inactive" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: NOW,
        devices: [{ deviceId: "other", lastActiveAt: ACTIVITY_EPOCH }],
        now: NOW,
      }),
    ).toEqual({ notify: true, reason: "ok" });
    expect(activityIsRecent(ACTIVITY_EPOCH, NOW_MS)).toBe(false);
    expect(activityIsRecent(ACTIVITY_EPOCH, Date.parse(ACTIVITY_EPOCH))).toBe(false);
  });

  it("ignores a far-future timestamp outside the window", () => {
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: at(ACTIVITY_WINDOW_MS + 1),
        devices: [],
        now: NOW,
      }),
    ).toEqual({ notify: false, reason: "inactive" });
    expect(
      decideDelivery({
        notifications: true,
        deviceId: "local",
        lastActivityAt: NOW,
        devices: [device("skewed", ACTIVITY_WINDOW_MS + 1)],
        now: NOW,
      }),
    ).toEqual({ notify: true, reason: "ok" });
  });
});

describe("acceptActivityAt", () => {
  it("defaults a missing timestamp to now and keeps the exact bounds", () => {
    expect(acceptActivityAt({ at: undefined, now: NOW })).toEqual({ ok: true, at: NOW });
    expect(acceptActivityAt({ at: at(ACTIVITY_FUTURE_SLACK_MS), now: NOW })).toEqual({
      ok: true,
      at: at(ACTIVITY_FUTURE_SLACK_MS),
    });
    expect(acceptActivityAt({ at: at(-ACTIVITY_PAST_LIMIT_MS), now: NOW })).toEqual({
      ok: true,
      at: at(-ACTIVITY_PAST_LIMIT_MS),
    });
    expect(acceptActivityAt({ at: at(ACTIVITY_FUTURE_SLACK_MS + 1), now: NOW })).toEqual({
      ok: false,
    });
    expect(acceptActivityAt({ at: at(-ACTIVITY_PAST_LIMIT_MS - 1), now: NOW })).toEqual({
      ok: false,
    });
    expect(acceptActivityAt({ at: "yesterday", now: NOW })).toEqual({ ok: false });
    expect(acceptActivityAt({ at: NOW, now: "nope" })).toEqual({ ok: false });
  });
});
