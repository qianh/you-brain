import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DRIVE_PATHS,
  createVirtualDeviceRecord,
  deviceRecordPath,
  type DeviceRecord,
} from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import type { DriveListQuery } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { SqliteStore } from "../../src/store/index.js";
import { SYNC_DRIVE_CURSOR } from "../../src/sync/cursors.js";
import { ProtocolSync, type DeviceIdentity, type SyncConfigUpdate } from "../../src/sync/index.js";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const VIRTUAL = "44444444-4444-4444-8444-444444444444";
const KEPT = "66666666-6666-4666-8666-666666666666";
const PHYSICAL = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-10-18T03:00:00.000Z");
const LATER = new Date("2026-10-18T04:00:00.000Z");
const DEVICES_PREFIX = `${DRIVE_PATHS.devicesDir}/`;

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

function openCountingStore(): CountingStore {
  const directory = mkdtempSync(join(tmpdir(), "you-brain-virtual-"));
  return new CountingStore(join(directory, "brain.sqlite"));
}

function desktop(deviceId: string, displayName: string): DeviceRecord {
  return {
    deviceId,
    displayName,
    kind: "desktop",
    platform: "darwin",
    appVersion: "0.1.0",
    protocolVersion: 1,
    capabilities: ["capture"],
    lastSeenAt: NOW.toISOString(),
    lastActiveAt: NOW.toISOString(),
  };
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

  it("drops a removed virtual device on the next pull and leaves physical rows", async () => {
    const drive = new MemoryDrive();
    const storeA = openStore();
    const storeB = openCountingStore();
    const configs: SyncConfigUpdate[] = [];
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
        listener: {
          onConfigChanged(update) {
            configs.push(update);
          },
        },
      });
      await syncA.register({ lastActiveAt: NOW.toISOString() });
      await syncB.register({ lastActiveAt: NOW.toISOString() });
      await syncA.registerVirtual(virtual(NOW));
      storeB.upsertDevice(desktop(PHYSICAL, "离线的物理设备"));
      await syncB.pull();
      expect(storeB.getDevice(VIRTUAL)?.deviceId).toBe(VIRTUAL);
      expect(storeB.getDevice(DEVICE_A)?.kind).toBe("desktop");
      expect(storeB.getDevice(DEVICE_B)?.deviceId).toBe(DEVICE_B);
      expect(storeB.deletes).toEqual([]);

      await syncA.removeDevice(VIRTUAL);
      expect(storeA.getDevice(VIRTUAL)).toBeNull();
      expect(await drive.findByPath(deviceRecordPath(VIRTUAL))).toBeNull();

      const beforeRemoval = configs.length;
      await syncB.pull();
      expect(storeB.getDevice(VIRTUAL)).toBeNull();
      expect(storeB.getDevice(DEVICE_A)?.kind).toBe("desktop");
      expect(storeB.getDevice(DEVICE_B)?.deviceId).toBe(DEVICE_B);
      expect(storeB.getDevice(PHYSICAL)?.kind).toBe("desktop");
      expect(storeB.deletes).toEqual([VIRTUAL]);
      expect(configs.slice(beforeRemoval).map((update) => update.removedDevices)).toEqual([
        [VIRTUAL],
      ]);

      const afterRemoval = configs.length;
      await syncB.pull();
      expect(storeB.deletes).toEqual([VIRTUAL]);
      expect(storeB.getDevice(VIRTUAL)).toBeNull();
      expect(configs.slice(afterRemoval).some((update) => update.removedDevices !== undefined)).toBe(
        false,
      );
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  it("clears a stale virtual row on the first pull and keeps this device", async () => {
    const drive = new MemoryDrive();
    const storeA = openStore();
    const storeB = openCountingStore();
    const configs: SyncConfigUpdate[] = [];
    try {
      const syncA = new ProtocolSync({
        drive,
        store: storeA,
        device: identity(DEVICE_A),
        now: () => NOW,
      });
      await syncA.register({ lastActiveAt: NOW.toISOString() });
      await syncA.registerVirtual(
        createVirtualDeviceRecord({ deviceId: KEPT, displayName: "仍在", now: NOW }),
      );
      storeB.upsertDevice(virtual(NOW));
      storeB.upsertDevice(desktop(PHYSICAL, "离线的物理设备"));
      storeB.upsertDevice(
        createVirtualDeviceRecord({ deviceId: DEVICE_B, displayName: "本机", now: NOW }),
      );
      const syncB = new ProtocolSync({
        drive,
        store: storeB,
        device: identity(DEVICE_B),
        now: () => NOW,
        listener: {
          onConfigChanged(update) {
            configs.push(update);
          },
        },
      });
      await syncB.pull();
      expect(storeB.getDevice(VIRTUAL)).toBeNull();
      expect(storeB.getDevice(KEPT)?.kind).toBe("virtual");
      expect(storeB.getDevice(DEVICE_A)?.kind).toBe("desktop");
      expect(storeB.getDevice(PHYSICAL)?.kind).toBe("desktop");
      expect(storeB.getDevice(DEVICE_B)?.kind).toBe("virtual");
      expect(storeB.deletes).toEqual([VIRTUAL]);
      expect(configs.some((update) => update.removedDevices?.join() === VIRTUAL)).toBe(true);
      expect(configs.some((update) => update.removedDevices?.length === 0)).toBe(false);

      const seen = configs.length;
      await syncB.pull();
      expect(storeB.deletes).toEqual([VIRTUAL]);
      expect(configs.slice(seen).some((update) => update.removedDevices !== undefined)).toBe(false);
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  it("keeps the cursor when device reconciliation cannot list, then retries", async () => {
    const drive = new FlakyDeviceList();
    const storeA = openStore();
    const storeB = openCountingStore();
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
      await syncA.register({ lastActiveAt: NOW.toISOString() });
      await syncB.register({ lastActiveAt: NOW.toISOString() });
      await syncA.registerVirtual(virtual(NOW));
      await syncB.pull();
      expect(storeB.getDevice(VIRTUAL)).not.toBeNull();
      const cursor = storeB.getCursor(SYNC_DRIVE_CURSOR);
      expect(cursor).not.toBeNull();

      await syncA.removeDevice(VIRTUAL);
      drive.failDeviceList = true;
      await expect(syncB.pull()).rejects.toThrow("device list failed");
      expect(storeB.getCursor(SYNC_DRIVE_CURSOR)).toBe(cursor);
      expect(storeB.getDevice(VIRTUAL)?.deviceId).toBe(VIRTUAL);
      expect(storeB.deletes).toEqual([]);
      expect(storeB.getDevice(DEVICE_A)?.kind).toBe("desktop");
      expect(storeB.getDevice(DEVICE_B)?.deviceId).toBe(DEVICE_B);

      drive.failDeviceList = false;
      await syncB.pull();
      expect(storeB.getCursor(SYNC_DRIVE_CURSOR)).not.toBe(cursor);
      expect(storeB.getDevice(VIRTUAL)).toBeNull();
      expect(storeB.deletes).toEqual([VIRTUAL]);
      expect(storeB.getDevice(DEVICE_A)?.kind).toBe("desktop");
      expect(storeB.getDevice(DEVICE_B)?.deviceId).toBe(DEVICE_B);
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  it("does not call deleteDevice when no virtual device was removed", async () => {
    const drive = new CountingDrive();
    const storeA = openStore();
    const storeB = openCountingStore();
    const configs: SyncConfigUpdate[] = [];
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
        listener: {
          onConfigChanged(update) {
            configs.push(update);
          },
        },
      });
      await syncA.register({ lastActiveAt: NOW.toISOString() });
      await syncB.register({ lastActiveAt: NOW.toISOString() });
      await syncA.registerVirtual(virtual(NOW));
      await syncB.pull();
      expect(storeB.deletes).toEqual([]);
      expect(drive.deviceLists).toBeGreaterThan(0);
      expect(configs.every((update) => update.removedDevices === undefined)).toBe(true);
      const lists = drive.deviceLists;

      await syncB.pull();
      expect(drive.deviceLists).toBe(lists);
      expect(storeB.deletes).toEqual([]);

      await syncA.heartbeat({ lastActiveAt: LATER.toISOString() });
      const before = configs.length;
      await syncB.pull();
      expect(drive.deviceLists).toBe(lists + 1);
      expect(storeB.deletes).toEqual([]);
      expect(storeB.getDevice(VIRTUAL)?.deviceId).toBe(VIRTUAL);
      expect(configs.slice(before).every((update) => update.removedDevices === undefined)).toBe(
        true,
      );
    } finally {
      storeA.close();
      storeB.close();
    }
  });
});

class CountingStore extends SqliteStore {
  readonly deletes: string[] = [];

  override deleteDevice(deviceId: string): void {
    this.deletes.push(deviceId);
    super.deleteDevice(deviceId);
  }
}

class CountingDrive extends MemoryDrive {
  deviceLists = 0;

  override async list(query: DriveListQuery): Promise<Awaited<ReturnType<MemoryDrive["list"]>>> {
    if (query.prefix === DEVICES_PREFIX) this.deviceLists += 1;
    return super.list(query);
  }
}

class FlakyDeviceList extends MemoryDrive {
  failDeviceList = false;

  override async list(query: DriveListQuery): Promise<Awaited<ReturnType<MemoryDrive["list"]>>> {
    if (this.failDeviceList && query.prefix === DEVICES_PREFIX) {
      throw new Error("device list failed");
    }
    return super.list(query);
  }
}
