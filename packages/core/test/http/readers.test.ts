import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent, type DeviceRecord, type TopicStatus } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import {
  listPortraitSnapshots,
  readPortraitFile,
} from "../../src/http/portrait-files.js";
import {
  createStoreReaders,
  partitionTopicRecords,
} from "../../src/http/queries.js";
import { SqliteStore, type TopicRecord } from "../../src/store/index.js";

const NOW = "2026-07-20T12:00:00.000Z";
const KEY = "ab".repeat(32);
const KEY_2 = "cd".repeat(32);

function directory(): string {
  return mkdtempSync(join(tmpdir(), "you-brain-readers-"));
}

function topic(
  topicId: string,
  lastActive: string | null,
  status: TopicStatus = "active",
  extra: Partial<TopicRecord> = {},
): TopicRecord {
  return {
    topicId,
    name: topicId,
    aliases: [],
    status,
    statusBy: "auto",
    summary: "",
    nextStep: "",
    lastActive,
    mergedInto: null,
    createdTs: "2026-07-01T00:00:00.000Z",
    lastUserOpAt: null,
    lastContentAt: null,
    userLocked: false,
    ...extra,
  };
}

describe("topic zones", () => {
  it("keeps the newest unfinished topics active and the rest in history", () => {
    const zones = partitionTopicRecords(
      [
        topic("a", "2026-07-20T10:00:00.000Z"),
        topic("d", "2026-07-19T10:00:00.000Z"),
        topic("b", "2026-01-01T00:00:00.000Z"),
        topic("c", "2026-07-20T11:00:00.000Z", "done"),
        topic("e", "2026-07-20T11:00:00.000Z", "active", { mergedInto: "a" }),
        topic("same", "2026-07-20T10:00:00.000Z"),
      ],
      { now: NOW, activeLimit: 1, historyDays: 30 },
    );
    expect(zones.active.map((item) => item.topicId)).toEqual(["a"]);
    expect(zones.history.map((item) => item.topicId)).toEqual([
      "c",
      "same",
      "d",
      "b",
    ]);
    expect(zones.history.find((item) => item.topicId === "c")?.zone).toBe("history");
  });
});

describe("sqlite readers", () => {
  it("reads today, topics, topic detail and devices from the store", async () => {
    const dataDir = directory();
    const store = new SqliteStore(join(dataDir, "state.sqlite"));
    try {
      const updatedAt = "2026-07-20T08:00:00.000Z";
      store.upsertSession({
        sessionKey: KEY,
        source: "codex",
        device: "laptop",
        startedAt: updatedAt,
        updatedAt,
        title: "标题",
        summary: "概要",
        fileId: "file-1",
        msgCount: 4,
        topicId: "a",
      });
      store.upsertSession({
        sessionKey: KEY_2,
        source: "cursor",
        device: "laptop",
        startedAt: updatedAt,
        updatedAt,
        title: "另一段",
        summary: "",
        topicId: "a",
      });
      const device: DeviceRecord = {
        deviceId: "11111111-1111-4111-8111-111111111111",
        displayName: "Mac",
        kind: "desktop",
        platform: "darwin",
        appVersion: "0.1.0",
        protocolVersion: 1,
        capabilities: ["capture"],
        lastSeenAt: NOW,
        lastActiveAt: NOW,
      };
      store.upsertDevice(device);
      store.replaceDerived({
        topics: [
          topic("a", "2026-07-20T10:00:00.000Z", "active", {
            name: "设计",
            aliases: ["design"],
            summary: "在做同步",
          }),
          topic("old", "2026-01-01T00:00:00.000Z", "parked"),
        ],
        sessions: [
          {
            sessionKey: KEY,
            source: "codex",
            fileId: "file-1",
            title: "标题",
            summary: "概要",
            refinedUpTo: 3,
            topicId: "a",
          },
          {
            sessionKey: KEY_2,
            source: "cursor",
            fileId: null,
            title: "另一段",
            summary: "",
            refinedUpTo: 0,
            topicId: "a",
          },
        ],
        conclusions: [
          {
            conclusionId: "c1",
            topicId: "a",
            sessionKey: KEY,
            text: "先写本地 API",
            ts: NOW,
          },
        ],
        todos: [
          {
            todoId: "td1",
            topicId: "a",
            sessionKey: KEY,
            text: "补测试",
            status: "open",
            statusBy: "auto",
            confidence: 0.9,
            ts: NOW,
            userLocked: false,
          },
        ],
        events: [
          createEvent({
            type: "topic.assigned",
            data: { topicId: "a", sessionKey: KEY_2 },
            device: "laptop",
            ts: NOW,
            seq: 1,
          }),
        ],
      });
      const readers = createStoreReaders(store, {
        timeZone: "UTC",
        activeLimit: 10,
        historyDays: 30,
        now: () => new Date(NOW),
      });
      const today = await readers.today();
      expect(today.date).toBe("2026-07-20");
      expect(today.sessions.map((session) => session.sessionKey)).toEqual([KEY, KEY_2]);
      const main = today.sessions.find((session) => session.sessionKey === KEY);
      expect(main).toMatchObject({
        topicId: "a",
        topicName: "设计",
        title: "标题",
        fileId: "file-1",
      });
      expect(main?.conclusions.map((item) => item.text)).toEqual(["先写本地 API"]);
      expect(main?.todos.map((item) => item.todoId)).toEqual(["td1"]);

      const active = await readers.topics({ zone: "active" });
      expect(active.topics.map((item) => item.topicId)).toEqual(["a"]);
      expect(active.topics[0]?.openTodoCount).toBe(1);
      const history = await readers.topics({ zone: "history", status: "parked" });
      expect(history.topics.map((item) => item.topicId)).toEqual(["old"]);
      const doneInActive = await readers.topics({ zone: "active", status: "done" });
      expect(doneInActive.topics).toEqual([]);

      const detail = await readers.topic("a");
      expect(detail?.name).toBe("设计");
      expect(detail?.zone).toBe("active");
      expect(detail?.sessions.map((session) => session.sessionKey).sort()).toEqual([
        KEY,
        KEY_2,
      ]);
      expect(detail?.conclusions).toHaveLength(1);
      expect(detail?.todos[0]?.text).toBe("补测试");
      expect(await readers.topic("missing")).toBeNull();
      expect((await readers.todo("td1"))?.status).toBe("open");
      expect(await readers.todo("missing")).toBeNull();
      expect(await readers.devices()).toEqual([device]);
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("portrait files", () => {
  it("reads a variant and lists snapshot files", async () => {
    const portraitDir = directory();
    try {
      mkdirSync(portraitDir, { recursive: true });
      writeFileSync(join(portraitDir, "full.md"), "# full\n", { mode: 0o600 });
      writeFileSync(join(portraitDir, "twin-v3-2026.md"), "# snap\n", { mode: 0o600 });
      writeFileSync(join(portraitDir, "notes.txt"), "nope", { mode: 0o600 });
      const full = await readPortraitFile(portraitDir, "full");
      expect(full?.content).toBe("# full\n");
      expect(full?.updatedAt).toEqual(expect.any(String));
      expect(await readPortraitFile(portraitDir, "missing")).toBeNull();
      await expect(readPortraitFile(portraitDir, "../full")).rejects.toThrow(
        /无效的数字分身变体/,
      );
      const snapshots = await listPortraitSnapshots(
        portraitDir,
        "digital-twin/JOHN-DIGITAL-TWIN-v*-*.md",
      );
      expect(snapshots.map((item) => item.name)).toEqual([]);
      const local = await listPortraitSnapshots(portraitDir, "*v*-*.md");
      expect(local.map((item) => item.name)).toEqual(["twin-v3-2026.md"]);
    } finally {
      rmSync(portraitDir, { recursive: true, force: true });
    }
  });
});
