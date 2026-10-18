import { describe, expect, it } from "bun:test";

import {
  parseDeviceRecord,
  TOPIC_STATUS_LABELS,
  TODO_STATUSES,
  type DeviceRecord,
} from "../src/index.js";

const record: DeviceRecord = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  displayName: "MacBook Air",
  kind: "desktop",
  platform: "darwin",
  appVersion: "0.1.0",
  protocolVersion: 1,
  capabilities: ["capture", "refine", "consolidate"],
  lastSeenAt: "2026-10-18T03:00:00.000Z",
  lastActiveAt: "2026-10-18T02:55:00.000Z",
};

describe("device record", () => {
  it("parses a registry file and rejects a bad kind or version", () => {
    expect(parseDeviceRecord(record)).toEqual(record);
    expect(() => parseDeviceRecord({ ...record, kind: "phone" })).toThrow();
    expect(() => parseDeviceRecord({ ...record, platform: "win32" })).toThrow();
    expect(() => parseDeviceRecord({ ...record, deviceId: "dev-1" })).toThrow();
    expect(() => parseDeviceRecord({ ...record, protocolVersion: 2 })).toThrow();
    expect(() => parseDeviceRecord({ ...record, capabilities: ["search"] })).toThrow();
  });
});

describe("status labels", () => {
  it("maps topic statuses to the product words", () => {
    expect(TOPIC_STATUS_LABELS).toEqual({
      active: "进行中",
      follow_up: "待跟进",
      done: "已完结",
      parked: "搁置",
    });
    expect(TODO_STATUSES).toEqual(["open", "done", "dropped"]);
  });
});
