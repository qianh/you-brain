import { describe, expect, test } from "bun:test";

import {
  hasRecordedActivity,
  isDeviceOnline,
  ONLINE_MS,
  orderDevices,
  resolvedWebDevice,
  roleCandidates,
  showAddDeviceHint,
  type RoleDevice,
} from "../../src/pages/devices/logic.js";

const NOW = Date.parse("2026-10-21T08:00:00.000Z");

function device(id: string, capabilities: string[]): RoleDevice & { displayName: string } {
  return { deviceId: id, displayName: id, capabilities };
}

describe("hasRecordedActivity", () => {
  test("treats the epoch timestamp as no recorded use", () => {
    expect(hasRecordedActivity("1970-01-01T00:00:00.000Z")).toBe(false);
    expect(hasRecordedActivity("1970-01-01T00:00:00.001Z")).toBe(true);
    expect(hasRecordedActivity("not-a-time")).toBe(false);
  });
});

describe("isDeviceOnline", () => {
  test("is online inside the 10 minute window and offline at the boundary", () => {
    expect(isDeviceOnline(new Date(NOW - (ONLINE_MS - 1)).toISOString(), NOW)).toBe(true);
    expect(isDeviceOnline(new Date(NOW - ONLINE_MS).toISOString(), NOW)).toBe(false);
    expect(isDeviceOnline(new Date(NOW - ONLINE_MS - 1).toISOString(), NOW)).toBe(false);
    expect(isDeviceOnline(new Date(NOW + 30_000).toISOString(), NOW)).toBe(true);
    expect(isDeviceOnline("not-a-time", NOW)).toBe(false);
    expect(isDeviceOnline("", NOW)).toBe(false);
  });
});

describe("orderDevices", () => {
  test("keeps this machine first and leaves the rest in place", () => {
    const devices = [device("a", []), device("local", []), device("b", [])];
    expect(orderDevices(devices, "local").map((item) => item.deviceId)).toEqual(["local", "a", "b"]);
    expect(orderDevices(devices, null).map((item) => item.deviceId)).toEqual(["a", "local", "b"]);
    expect(orderDevices(devices, "missing").map((item) => item.deviceId)).toEqual(["a", "local", "b"]);
  });
});

describe("roleCandidates", () => {
  const devices = [
    device("air", ["capture", "refine", "consolidate"]),
    device("mini", ["capture", "refine"]),
    device("server", ["consolidate"]),
    device("fresh", ["capture"]),
  ];

  test("keeps devices that can do the job, and the current assignee", () => {
    expect(roleCandidates(devices, "main", null).map((item) => item.deviceId)).toEqual(["air", "server"]);
    expect(roleCandidates(devices, "web", null).map((item) => item.deviceId)).toEqual(["air", "mini"]);
    expect(roleCandidates(devices, "main", "fresh").map((item) => item.deviceId)).toEqual(["fresh", "air", "server"]);
    expect(roleCandidates(devices, "web", "server").map((item) => item.deviceId)).toEqual(["server", "air", "mini"]);
  });

  test("falls back to every device when none declare the capability", () => {
    const only = [device("fresh", ["capture"])];
    expect(roleCandidates(only, "main", null).map((item) => item.deviceId)).toEqual(["fresh"]);
    expect(roleCandidates(only, "web", "fresh").map((item) => item.deviceId)).toEqual(["fresh"]);
    expect(roleCandidates([], "main", null)).toEqual([]);
  });
});

describe("resolved roles", () => {
  test("follows the main device when web processor is unset", () => {
    expect(resolvedWebDevice("main", null)).toBe("main");
    expect(resolvedWebDevice("main", "web")).toBe("web");
    expect(resolvedWebDevice(null, null)).toBeNull();
    expect(showAddDeviceHint(1)).toBe(true);
    expect(showAddDeviceHint(0)).toBe(false);
    expect(showAddDeviceHint(3)).toBe(false);
  });
});
