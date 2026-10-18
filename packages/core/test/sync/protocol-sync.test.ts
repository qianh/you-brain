import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DRIVE_PATHS,
  createEvent,
  deviceRecordPath,
  eventLogPath,
  parseEventsJsonl,
  serializeEventsJsonl,
  ulid,
  type DeviceRecord,
  type Event,
} from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import type { DrivePort, DrivePutInput, DriveUpdateOptions } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { SqliteStore } from "../../src/store/index.js";
import {
  EVENT_FLUSH_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  ProtocolSync,
  selectNewLines,
  zonedDay,
  type DeviceIdentity,
  type SyncConfigUpdate,
} from "../../src/sync/index.js";
import { upsertByPath } from "../../src/upload/write.js";
import { foldEvents, persistTopicBook } from "../../src/topics/index.js";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";

function identity(deviceId: string, displayName: string): DeviceIdentity {
  return {
    deviceId,
    displayName,
    kind: "desktop",
    platform: "darwin",
    appVersion: "0.1.0",
    capabilities: ["capture", "refine"],
  };
}

function topic(
  device: string,
  seq: number,
  ts: string,
  topicId: string,
  name: string,
): Event {
  return createEvent({
    type: "topic.created",
    device,
    seq,
    ts,
    id: ulid(Date.parse(ts) + seq),
    data: { topicId, name, aliases: [] },
  });
}

function wrap(drive: MemoryDrive, overrides: Partial<DrivePort>): DrivePort {
  return new Proxy(drive, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(overrides, property)) {
        return overrides[property as keyof DrivePort];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DrivePort;
}

function openStore(): { store: SqliteStore; close: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "you-brain-sync-"));
  const store = new SqliteStore(join(directory, "brain.sqlite"));
  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("event log lines and zoned days", () => {
  it("reads only new lines and rereads a shorter file", () => {
    expect(selectNewLines("a\nb\n", 1)).toEqual({ lines: ["b"], next: 2, reset: false });
    expect(selectNewLines("a\n", 2)).toEqual({ lines: ["a"], next: 1, reset: true });
    expect(selectNewLines("", 0)).toEqual({ lines: [], next: 0, reset: false });
  });

  it("uses the configured timezone, including the Shanghai midnight boundary", () => {
    expect(zonedDay(new Date("2026-07-01T15:59:59.000Z"), "Asia/Shanghai")).toBe("2026-07-01");
    expect(zonedDay(new Date("2026-07-01T16:00:00.000Z"), "Asia/Shanghai")).toBe("2026-07-02");
    expect(zonedDay(new Date("2026-07-02T03:30:00.000Z"), "America/New_York")).toBe("2026-07-01");
    expect(EVENT_FLUSH_INTERVAL_MS).toBe(30_000);
    expect(HEARTBEAT_INTERVAL_MS).toBe(300_000);
  });
});

describe("protocol sync", () => {
  it("applies local events immediately and replicates them on pull", async () => {
    const drive = new MemoryDrive();
    const local = openStore();
    const remote = openStore();
    const topics: string[] = [];
    try {
      const syncA = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      const syncB = new ProtocolSync({
        drive,
        store: remote.store,
        device: identity(DEVICE_B, "Studio"),
        listener: {
          onTopicsChanged(book) {
            topics.push(...book.topics.map((topic) => topic.topicId));
          },
        },
      });
      const event = await syncA.append(
        "topic.created",
        { topicId: "topic-alpha", name: "Alpha", aliases: ["A"] },
        { ts: "2026-07-01T02:00:00.000Z" },
      );

      expect(event.device).toBe(DEVICE_A);
      expect(event.seq).toBe(1);
      expect(local.store.getTopic("topic-alpha")).toMatchObject({
        name: "Alpha",
        aliases: ["A"],
      });
      expect(local.store.getOutbox(event.id)?.status).toBe("pending");

      const flushed = await syncA.flush();
      expect(flushed.files.map((file) => file.path)).toEqual([
        eventLogPath(DEVICE_A, "2026-07-01"),
      ]);
      expect(local.store.getOutbox(event.id)?.status).toBe("acked");
      expect(syncA.pendingEvents()).toEqual([]);

      const eventsBefore = local.store.listEvents();
      const topicsBefore = local.store.listTopics();
      await syncA.pull();
      expect(local.store.listEvents()).toEqual(eventsBefore);
      expect(local.store.listTopics()).toEqual(topicsBefore);

      await syncB.pull();
      expect(topics).toEqual(["topic-alpha"]);
      expect(remote.store.listEvents()).toEqual(local.store.listEvents());
      expect(remote.store.listTopics()).toEqual(local.store.listTopics());
    } finally {
      local.close();
      remote.close();
    }
  });

  it("converges when both devices create events, including a same-name merge", async () => {
    const drive = new MemoryDrive();
    const local = openStore();
    const remote = openStore();
    try {
      const syncA = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      const syncB = new ProtocolSync({
        drive,
        store: remote.store,
        device: identity(DEVICE_B, "Studio"),
      });
      await syncA.append(
        "topic.created",
        { topicId: "topic-alpha", name: "Alpha", aliases: [] },
        { ts: "2026-07-01T01:00:00.000Z" },
      );
      await syncB.append(
        "topic.created",
        { topicId: "topic-beta", name: "Beta", aliases: [] },
        { ts: "2026-07-01T02:00:00.000Z" },
      );
      await syncA.append(
        "topic.created",
        { topicId: "topic-plan-a", name: "Plan Review", aliases: [] },
        { ts: "2026-07-01T03:00:00.000Z" },
      );
      await syncB.append(
        "topic.created",
        { topicId: "topic-plan-b", name: "plan review", aliases: [] },
        { ts: "2026-07-01T04:00:00.000Z" },
      );
      await syncA.flush();
      await syncB.flush();
      await syncA.pull();
      await syncB.pull();

      expect(local.store.listEvents()).toEqual(remote.store.listEvents());
      expect(local.store.listTopics()).toEqual(remote.store.listTopics());
      expect(local.store.getTopic("topic-plan-b")?.mergedInto).toBe("topic-plan-a");

      await syncA.append(
        "topic.created",
        { topicId: "topic-gamma", name: "Gamma", aliases: [] },
        { ts: "2026-07-01T05:00:00.000Z" },
      );
      await syncB.append(
        "topic.created",
        { topicId: "topic-delta", name: "Delta", aliases: [] },
        { ts: "2026-07-01T06:00:00.000Z" },
      );
      await syncA.flush();
      await syncB.flush();
      await syncA.pull();
      await syncB.pull();

      expect(local.store.listEvents()).toEqual(remote.store.listEvents());
      expect(local.store.listTopics()).toEqual(remote.store.listTopics());
      expect(local.store.listTopics().map((item) => item.topicId)).toEqual([
        "topic-alpha",
        "topic-beta",
        "topic-delta",
        "topic-gamma",
        "topic-plan-a",
        "topic-plan-b",
      ]);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("keeps the outbox when the drive is offline and replays it in order", async () => {
    const drive = new MemoryDrive();
    let offline = true;
    const wrapped = wrap(drive, {
      async create(input: DrivePutInput) {
        if (offline) throw new Error("offline");
        return drive.create(input);
      },
      async update(fileId: string, content: Buffer | string, options?: DriveUpdateOptions) {
        if (offline) throw new Error("offline");
        return drive.update(fileId, content, options);
      },
    });
    const local = openStore();
    const remote = openStore();
    try {
      const syncA = new ProtocolSync({
        drive: wrapped,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      const syncB = new ProtocolSync({
        drive,
        store: remote.store,
        device: identity(DEVICE_B, "Studio"),
      });
      const first = await syncA.append(
        "topic.created",
        { topicId: "topic-1", name: "One", aliases: [] },
        { ts: "2026-07-01T02:00:00.000Z" },
      );
      const second = await syncA.append(
        "topic.created",
        { topicId: "topic-2", name: "Two", aliases: [] },
        { ts: "2026-07-01T03:00:00.000Z" },
      );
      await expect(syncA.flush()).rejects.toThrow(/offline/);
      expect(syncA.pendingEvents().map((event) => event.seq)).toEqual([1, 2]);
      expect(local.store.getOutbox(first.id)?.status).toBe("pending");
      expect(local.store.getOutbox(second.id)?.status).toBe("pending");
      expect(await drive.readPath(eventLogPath(DEVICE_A, "2026-07-01"))).toBeNull();

      offline = false;
      await syncA.flush();
      expect(local.store.getOutbox(first.id)?.status).toBe("acked");
      expect(local.store.getOutbox(second.id)?.status).toBe("acked");
      const text = (await drive.readPath(eventLogPath(DEVICE_A, "2026-07-01")))!.bytes.toString(
        "utf8",
      );
      expect(parseEventsJsonl(text).events.map((event) => event.seq)).toEqual([1, 2]);

      await syncB.pull();
      expect(remote.store.listEvents()).toEqual(local.store.listEvents());
      expect(remote.store.listTopics()).toEqual(local.store.listTopics());
    } finally {
      local.close();
      remote.close();
    }
  });

  it("shards event files by roles.timezone and retries a later day without rewriting the earlier file", async () => {
    const drive = new MemoryDrive();
    const day2 = eventLogPath(DEVICE_A, "2026-07-02");
    let blockDay2 = true;
    const wrapped = wrap(drive, {
      async create(input: DrivePutInput) {
        if (blockDay2 && input.path === day2) throw new Error("offline");
        return drive.create(input);
      },
      async update(fileId: string, content: Buffer | string, options?: DriveUpdateOptions) {
        const current = await drive.read(fileId);
        if (blockDay2 && current.path === day2) throw new Error("offline");
        return drive.update(fileId, content, options);
      },
    });
    const local = openStore();
    const remote = openStore();
    try {
      const syncA = new ProtocolSync({
        drive: wrapped,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      const afternoon = await syncA.append(
        "topic.created",
        { topicId: "topic-afternoon", name: "Afternoon", aliases: [] },
        { ts: "2026-07-01T15:00:00.000Z" },
      );
      const nextDay = await syncA.append(
        "topic.created",
        { topicId: "topic-next", name: "Next", aliases: [] },
        { ts: "2026-07-01T17:00:00.000Z" },
      );
      await expect(syncA.flush()).rejects.toThrow(/offline/);
      const day1Path = eventLogPath(DEVICE_A, "2026-07-01");
      const day1File = await drive.findByPath(day1Path);
      expect(day1File).not.toBeNull();
      expect(await drive.findByPath(day2)).toBeNull();
      expect(local.store.getOutbox(afternoon.id)?.status).toBe("acked");
      expect(local.store.getOutbox(nextDay.id)?.status).toBe("pending");

      blockDay2 = false;
      const retried = await syncA.flush();
      expect(retried.files.map((file) => file.day)).toEqual(["2026-07-02"]);
      expect(local.store.getOutbox(nextDay.id)?.status).toBe("acked");
      expect((await drive.findByPath(day1Path))!.id).toBe(day1File!.id);

      const syncB = new ProtocolSync({
        drive,
        store: remote.store,
        device: identity(DEVICE_B, "Studio"),
      });
      await syncB.pull();
      expect(remote.store.listEvents().map((event) => event.id)).toEqual([
        afternoon.id,
        nextDay.id,
      ]);

      const morning = await syncA.append(
        "topic.created",
        { topicId: "topic-morning", name: "Morning", aliases: [] },
        { ts: "2026-07-01T10:00:00.000Z" },
      );
      await syncA.flush();
      expect((await drive.findByPath(day1Path))!.id).toBe(day1File!.id);
      const day1Text = (await drive.read(day1File!.id)).bytes.toString("utf8");
      expect(parseEventsJsonl(day1Text).events.map((event) => event.seq)).toEqual([
        afternoon.seq,
        morning.seq,
      ]);

      const incremental = await syncB.pull();
      expect(incremental.initial).toBe(false);
      expect(incremental.applied).toBe(1);
      expect(remote.store.listEvents()).toEqual(local.store.listEvents());
      expect(remote.store.listTopics()).toEqual(local.store.listTopics());
      expect(remote.store.listEvents().map((event) => event.id)).toEqual([
        morning.id,
        afternoon.id,
        nextDay.id,
      ]);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("writes the New York day, not the UTC or Shanghai day", async () => {
    const drive = new MemoryDrive();
    const local = openStore();
    try {
      const sync = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      await sync.updateRoles({ timezone: "America/New_York" });
      await sync.append(
        "topic.created",
        { topicId: "topic-ny", name: "Night", aliases: [] },
        { ts: "2026-07-02T03:30:00.000Z" },
      );
      await sync.flush();
      expect(await drive.findByPath(eventLogPath(DEVICE_A, "2026-07-01"))).not.toBeNull();
      expect(await drive.findByPath(eventLogPath(DEVICE_A, "2026-07-02"))).toBeNull();
    } finally {
      local.close();
    }
  });

  it("replays every protocol event on the first pull", async () => {
    const drive = new MemoryDrive();
    const seeded = [
      topic(DEVICE_A, 1, "2026-07-01T00:00:00.000Z", "topic-a", "Alpha"),
      topic(DEVICE_B, 1, "2026-07-01T01:00:00.000Z", "topic-b", "Beta"),
    ];
    const first = seeded[0];
    const second = seeded[1];
    if (!first || !second) throw new Error("missing seed events");
    await upsertByPath(drive, eventLogPath(DEVICE_A, "2026-07-01"), serializeEventsJsonl([first]), {
      mimeType: "application/jsonl",
    });
    await upsertByPath(drive, eventLogPath(DEVICE_B, "2026-07-01"), serializeEventsJsonl([second]), {
      mimeType: "application/jsonl",
    });
    const device: DeviceRecord = {
      deviceId: DEVICE_A,
      displayName: "Already",
      kind: "desktop",
      platform: "darwin",
      appVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["capture"],
      lastSeenAt: "2026-07-01T00:00:00.000Z",
      lastActiveAt: "2026-07-01T00:00:00.000Z",
    };
    await upsertByPath(drive, deviceRecordPath(DEVICE_A), `${JSON.stringify(device, null, 2)}\n`, {
      mimeType: "application/json",
    });
    await upsertByPath(
      drive,
      DRIVE_PATHS.sharedConfig,
      `${JSON.stringify({ llm: { model: "preset" } }, null, 2)}\n`,
      { mimeType: "application/json" },
    );

    const local = openStore();
    const expected = openStore();
    const configs: SyncConfigUpdate[] = [];
    try {
      persistTopicBook(expected.store, foldEvents(seeded));
      const sync = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_B, "New"),
        listener: {
          onConfigChanged(update) {
            configs.push(update);
          },
        },
      });
      const pulled = await sync.pull();
      expect(pulled.initial).toBe(true);
      expect(pulled.applied).toBe(2);
      expect(local.store.listEvents()).toEqual(expected.store.listEvents());
      expect(local.store.listTopics()).toEqual(expected.store.listTopics());
      expect(local.store.getDevice(DEVICE_A)).toEqual(device);
      expect(configs.at(-1)?.shared?.llm.model).toBe("preset");
      expect(await drive.readPath(DRIVE_PATHS.protocolFile)).not.toBeNull();

      const again = await sync.pull();
      expect(again.initial).toBe(false);
      expect(again.applied).toBe(0);
      expect(local.store.listEvents()).toHaveLength(2);
    } finally {
      local.close();
      expected.close();
    }
  });

  it("reads new event lines and falls back to a full read when the file shrinks", async () => {
    const drive = new MemoryDrive();
    const local = openStore();
    const path = eventLogPath(DEVICE_B, "2026-07-01");
    const event1 = topic(DEVICE_B, 1, "2026-07-01T00:00:00.000Z", "topic-1", "One");
    const event2 = topic(DEVICE_B, 2, "2026-07-01T01:00:00.000Z", "topic-2", "Two");
    const event3 = topic(DEVICE_B, 3, "2026-07-01T02:00:00.000Z", "topic-3", "Three");
    try {
      await upsertByPath(drive, path, serializeEventsJsonl([event1]), {
        mimeType: "application/jsonl",
      });
      const sync = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      await sync.pull();
      const file = await drive.findByPath(path);
      if (!file) throw new Error("missing event file");
      const event2Line = serializeEventsJsonl([event2]).trim();
      await drive.update(file.id, `NOT JSON\n${event2Line}\n`);
      const suffix = await sync.pull();
      expect(suffix.initial).toBe(false);
      expect(suffix.lineErrors).toEqual([]);
      expect(suffix.applied).toBe(1);
      expect(local.store.listEvents().map((event) => event.id)).toEqual([event1.id, event2.id]);

      await drive.update(file.id, serializeEventsJsonl([event3]));
      const reset = await sync.pull();
      expect(reset.initial).toBe(false);
      expect(reset.applied).toBe(1);
      expect(local.store.listEvents().map((event) => event.id)).toEqual([
        event1.id,
        event2.id,
        event3.id,
      ]);
    } finally {
      local.close();
    }
  });

  it("notifies inbox and digital-twin listeners without applying those files as events", async () => {
    const drive = new MemoryDrive();
    const local = openStore();
    const inbox: string[] = [];
    const twins: string[] = [];
    try {
      const sync = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
        listener: {
          onInboxChanged(files) {
            inbox.push(...files.map((file) => file.path));
          },
          onDigitalTwinChanged(files) {
            twins.push(...files.map((file) => file.path));
          },
        },
      });
      await sync.pull();
      await drive.put({
        path: "inbox/web-main/session.md",
        bytes: Buffer.from("session"),
        mimeType: "text/markdown",
      });
      await drive.put({
        path: "digital-twin/JOHN-DIGITAL-TWIN-latest.md",
        bytes: Buffer.from("# twin"),
        mimeType: "text/markdown",
      });
      const pulled = await sync.pull();
      expect(pulled.initial).toBe(false);
      expect(pulled.applied).toBe(0);
      expect(inbox).toEqual(["inbox/web-main/session.md"]);
      expect(twins).toEqual(["digital-twin/JOHN-DIGITAL-TWIN-latest.md"]);
      expect(local.store.listEvents()).toEqual([]);
    } finally {
      local.close();
    }
  });

  it("registers a device and keeps lastActiveAt until an active heartbeat", async () => {
    const drive = new MemoryDrive();
    const local = openStore();
    const remote = openStore();
    let now = new Date("2026-07-01T00:00:00.000Z");
    try {
      const sync = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
        now: () => now,
      });
      expect((await sync.readShared()).drive.root).toBe("brain-hub");
      expect((await sync.readShared()).topics).toMatchObject({ activeLimit: 10, historyDays: 30 });
      expect(await drive.readPath(DRIVE_PATHS.sharedConfig)).toBeNull();
      expect((await sync.readRoles()).timezone).toBe("Asia/Shanghai");

      const registered = await sync.register();
      expect(registered).toMatchObject({
        deviceId: DEVICE_A,
        displayName: "MacBook Air",
        kind: "desktop",
        platform: "darwin",
        appVersion: "0.1.0",
        protocolVersion: 1,
        capabilities: ["capture", "refine"],
        lastSeenAt: now.toISOString(),
        lastActiveAt: now.toISOString(),
      });
      const fileId = (await drive.findByPath(deviceRecordPath(DEVICE_A)))!.id;
      const protocolId = (await drive.findByPath(DRIVE_PATHS.protocolFile))!.id;

      now = new Date("2026-07-01T00:05:00.000Z");
      const seen = await sync.heartbeat();
      expect(seen.lastSeenAt).toBe(now.toISOString());
      expect(seen.lastActiveAt).toBe(registered.lastActiveAt);
      expect((await drive.findByPath(deviceRecordPath(DEVICE_A)))!.id).toBe(fileId);

      now = new Date("2026-07-01T00:06:00.000Z");
      const active = await sync.heartbeat({ active: true });
      expect(active.lastSeenAt).toBe(now.toISOString());
      expect(active.lastActiveAt).toBe(now.toISOString());
      expect(local.store.getDevice(DEVICE_A)).toEqual(active);
      await sync.ensureProtocol();
      expect((await drive.findByPath(DRIVE_PATHS.protocolFile))!.id).toBe(protocolId);

      const syncB = new ProtocolSync({
        drive,
        store: remote.store,
        device: identity(DEVICE_B, "Studio"),
      });
      await syncB.pull();
      expect(remote.store.getDevice(DEVICE_A)).toEqual(active);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("merges concurrent config edits field by field", async () => {
    const drive = new MemoryDrive();
    const local = openStore();
    const remote = openStore();
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let armed = true;
    const wrapped = wrap(drive, {
      async update(fileId: string, content: Buffer | string, options?: DriveUpdateOptions) {
        if (armed) {
          armed = false;
          markEntered();
          await hold;
        }
        return drive.update(fileId, content, options);
      },
    });
    try {
      const syncA = new ProtocolSync({
        drive: wrapped,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      const syncB = new ProtocolSync({
        drive,
        store: remote.store,
        device: identity(DEVICE_B, "Studio"),
      });
      await syncB.updateShared({ ui: { shortcut: "seed" } });
      const fileId = (await drive.findByPath(DRIVE_PATHS.sharedConfig))!.id;
      const pending = syncA.updateShared({ llm: { model: "model-a" } });
      await entered;
      await syncB.updateShared({ ui: { language: "en" } });
      releaseHold();
      await pending;

      const shared = await syncA.readShared();
      expect(shared.llm.model).toBe("model-a");
      expect(shared.ui.language).toBe("en");
      expect(shared.ui.shortcut).toBe("seed");
      expect(await syncB.readShared()).toEqual(shared);
      expect((await drive.findByPath(DRIVE_PATHS.sharedConfig))!.id).toBe(fileId);
    } finally {
      local.close();
      remote.close();
    }
  });

  it("continues the device sequence across ProtocolSync instances", async () => {
    const drive = new MemoryDrive();
    const local = openStore();
    try {
      const sync = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      expect((await sync.append("topic.created", {
        topicId: "topic-1",
        name: "One",
        aliases: [],
      })).seq).toBe(1);
      const restarted = new ProtocolSync({
        drive,
        store: local.store,
        device: identity(DEVICE_A, "MacBook Air"),
      });
      expect((await restarted.append("topic.created", {
        topicId: "topic-2",
        name: "Two",
        aliases: [],
      })).seq).toBe(2);
      expect(local.store.listEvents()).toHaveLength(2);
    } finally {
      local.close();
    }
  });
});
