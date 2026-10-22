import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createVirtualDeviceRecord,
  deviceRecordPath,
  type DeviceRecord,
} from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { SqliteStore } from "../../src/store/index.js";
import { ProtocolSync, type DeviceIdentity } from "../../src/sync/index.js";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const VIRTUAL = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-18T03:00:00.000Z");
const LATER = new Date("2026-10-18T04:00:00.000Z");

function identity(deviceId: string): DeviceIdentity {
  return {
    deviceId,
    displayName: deviceId === DEVICE_A ? "甲" : "乙",
    kind: "desktop",
    platform: "darwin",
    appVersion: "0.1.0",
    capabilities: ["capture"],
  };
}

function openStore(): SqliteStore {
  const directory = mkdtempSync(join(tmpdir(), "you-brain-virtual-"));
  const store = new SqliteStore(join(directory, "brain.sqlite"));
  return store;
}

function virtual(now: Date, displayName = "沉淀机器人"): DeviceRecord {
  return createVirtualDeviceRecord({
    deviceId: VIRTUAL,
    displayName,
    now,
  });
}

describe("virtual device records", () => {
  it("registers a virtual device that another device can pull", async () => {
    const drive = new MemoryDrive();
    const storeA = openStore();
    const storeB = openStore();
    try {
      const syncA = new ProtocolSync({
        drive,
        store: storeA,
        device: identity(DEVICE_A),
        now: () => NOW,
      });
      const syncB = new ProtocolSync({
        drive,
        store: storeB,
        device: identity(DEVICE_B),
        now: () => NOW,
      });
      const created = await syncA.registerVirtual(virtual(NOW));
      expect(created.kind).toBe("virtual");
      expect(created.platform).toBe("bot");
      expect(await drive.findByPath(deviceRecordPath(VIRTUAL))).not.toBeNull();
      expect(storeA.getDevice(VIRTUAL)?.displayName).toBe("沉淀机器人");

      await syncB.pull();
      expect(storeB.getDevice(VIRTUAL)?.deviceId).toBe(VIRTUAL);

      const rewritten = await syncA.registerVirtual(virtual(new Date("2026-10-18T02:00:00.000Z"), "旧心跳"));
      expect(rewritten.lastActiveAt).toBe(NOW.toISOString());
      expect(rewritten.lastSeenAt).toBe("2026-10-18T02:00:00.000Z");
      expect(rewritten.displayName).toBe("旧心跳");

      const newer = await syncA.registerVirtual(virtual(LATER, "新心跳"));
      expect(newer.lastActiveAt).toBe(LATER.toISOString());
      expect(newer.lastSeenAt).toBe(LATER.toISOString());
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  it("refuses a desktop record and a non-virtual removal", async () => {
    const drive = new MemoryDrive();
    const store = openStore();
    try {
      const sync = new ProtocolSync({
        drive,
        store,
        device: identity(DEVICE_A),
        now: () => NOW,
      });
      const desktop = {
        ...virtual(NOW),
        kind: "desktop" as const,
        platform: "darwin" as const,
      };
      await expect(sync.registerVirtual(desktop)).rejects.toBeInstanceOf(YouBrainError);
      await sync.register( { lastActiveAt: NOW.toISOString() });
      await expect(sync.removeDevice(DEVICE_A)).rejects.toThrow("只能移除虚拟设备");
      await expect(sync.removeDevice(VIRTUAL)).rejects.toThrow("设备不存在");
    } finally {
      store.close();
    }
  });

  it("trashes the file locally but an incremental pull does not drop the other device's row", async () => {
    const drive = new MemoryDrive();
    const storeA = openStore();
    const storeB = openStore();
    try {
      const syncA = new ProtocolSync({
        drive,
        store: storeA,
        device: identity(DEVICE_A),
        now: () => NOW,
      });
      const syncB = new ProtocolSync({
        drive,
        store: storeB,
        device: identity(DEVICE_B),
        now: () => NOW,
      });
      await syncA.registerVirtual(virtual(NOW));
      await syncB.pull();
      expect(storeB.getDevice(VIRTUAL)).not.toBeNull();

      await syncA.removeDevice(VIRTUAL);
      expect(storeA.getDevice(VIRTUAL)).toBeNull();
      expect(await drive.findByPath(deviceRecordPath(VIRTUAL))).toBeNull();

      await syncB.pull();
      expect(storeB.getDevice(VIRTUAL)?.deviceId).toBe(VIRTUAL);
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});
