import { describe, expect, it } from "bun:test";

import { createVirtualDeviceRecord, parseDeviceRecord } from "../src/index.js";

const NOW = new Date("2026-10-18T03:00:00.000Z");
const DEVICE = "44444444-4444-4444-8444-444444444444";

describe("createVirtualDeviceRecord", () => {
  it("fills virtual defaults and validates the record", () => {
    const record = createVirtualDeviceRecord({ displayName: "沉淀机器人", now: NOW });
    expect(record.kind).toBe("virtual");
    expect(record.platform).toBe("bot");
    expect(record.appVersion).toBe("virtual");
    expect(record.protocolVersion).toBe(1);
    expect(record.capabilities).toEqual(["refine", "consolidate"]);
    expect(record.lastSeenAt).toBe(NOW.toISOString());
    expect(record.lastActiveAt).toBe(NOW.toISOString());
    expect(record.deviceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(parseDeviceRecord(record)).toEqual(record);
  });

  it("keeps an explicit id, version, and capability list, including an empty list", () => {
    const record = createVirtualDeviceRecord({
      deviceId: DEVICE,
      displayName: "bot",
      capabilities: [],
      appVersion: "1.2.3",
      now: NOW,
    });
    expect(record.deviceId).toBe(DEVICE);
    expect(record.capabilities).toEqual([]);
    expect(record.appVersion).toBe("1.2.3");
  });

  it("rejects a blank display name", () => {
    expect(() => createVirtualDeviceRecord({ displayName: "", now: NOW })).toThrow();
  });
});
