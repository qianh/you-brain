import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvent, type DeviceRecord } from "@you-brain/protocol";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import {
  SCHEMA_MIGRATIONS,
  SCHEMA_VERSION,
  TOPIC_TABLES,
  SqliteStore,
  zonedDayRange,
  type SessionUpsert,
} from "../../src/store/index.js";

const ISO = "2026-07-20T00:00:00.000Z";

function key(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "you-brain-store-"));
}

function withStore(run: (store: SqliteStore) => void): void {
  const directory = tempDir();
  const store = new SqliteStore(join(directory, "brain.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function session(n: number, updatedAt: string, extra: Partial<SessionUpsert> = {}): SessionUpsert {
  return {
    sessionKey: key(n),
    source: "codex",
    device: "laptop",
    startedAt: updatedAt,
    updatedAt,
    ...extra,
  };
}

describe("sqlite store", () => {
  it("opens a WAL database at the current schema", () => {
    withStore((store) => {
      expect(store.journalMode()).toBe("wal");
      expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
      expect(store.schemaVersion()).toBe(2);
      expect(store.migrationCount()).toBe(SCHEMA_MIGRATIONS.length);
      const objects = store.schemaObjects();
      for (const table of TOPIC_TABLES) expect(objects).toContain(table);
      expect(objects).toContain("schema_migrations");
      expect(objects).toContain("events_type");
      expect(objects).not.toContain("search_chunks");
      expect(objects).not.toContain("search_vectors");
    });
  });

  it("reopens a file database and keeps rows", () => {
    const directory = tempDir();
    const path = join(directory, "brain.sqlite");
    const store = new SqliteStore(path);
    store.upsertSession(session(1, ISO, { title: "kept" }));
    store.close();
    store.close();
    const again = new SqliteStore(path);
    try {
      expect(again.schemaVersion()).toBe(2);
      expect(again.getSession(key(1))?.title).toBe("kept");
    } finally {
      again.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("upgrades a version-1 database without dropping sessions", () => {
    const directory = tempDir();
    const path = join(directory, "brain.sqlite");
    const first = SCHEMA_MIGRATIONS[0];
    if (!first) throw new Error("missing migration 1");
    const raw = new Database(path);
    raw.exec(first.sql);
    raw.exec("PRAGMA user_version = 1");
    raw
      .query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(1, ISO);
    raw
      .query(
        `
        INSERT INTO sessions (
          session_key, source, device, title, summary, started_at, updated_at,
          started_at_ms, updated_at_ms, msg_count, refined_up_to
        ) VALUES (?, 'codex', 'laptop', 'legacy', '', ?, ?, ?, ?, 2, 0)
      `,
      )
      .run(key(7), ISO, ISO, Date.parse(ISO), Date.parse(ISO));
    raw.close();

    const store = new SqliteStore(path);
    try {
      expect(store.schemaVersion()).toBe(2);
      expect(store.migrationCount()).toBe(2);
      expect(store.schemaObjects()).toContain("events_type");
      expect(store.getSession(key(7))?.title).toBe("legacy");
      expect(store.getSession(key(7))?.msgCount).toBe(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("merges partial session upserts and rejects bad keys", () => {
    withStore((store) => {
      const startedAt = "2026-07-19T16:00:00.000Z";
      const updatedAt = "2026-07-19T16:30:00.000Z";
      store.upsertSession({
        sessionKey: key(1),
        source: "codex",
        device: "laptop",
        startedAt,
        updatedAt,
        fileId: "capture-file",
        title: "Hello",
        msgCount: 4,
        refinedUpTo: 1,
        topicId: "topic-1",
      });
      const merged = store.upsertSession({
        sessionKey: key(1),
        source: "claude-code",
        device: "desktop",
        startedAt,
        updatedAt: "2026-07-19T18:00:00.000Z",
        summary: "sum",
      });
      expect(merged).toMatchObject({
        source: "claude-code",
        device: "desktop",
        fileId: "capture-file",
        title: "Hello",
        summary: "sum",
        msgCount: 4,
        refinedUpTo: 1,
        topicId: "topic-1",
        updatedAt: "2026-07-19T18:00:00.000Z",
      });
      const cleared = store.upsertSession({
        sessionKey: key(1),
        source: "claude-code",
        device: "desktop",
        startedAt,
        updatedAt: "2026-07-19T18:00:00.000Z",
        fileId: null,
        topicId: null,
      });
      expect(cleared.fileId).toBeNull();
      expect(cleared.topicId).toBeNull();
      expect(cleared.title).toBe("Hello");
      expect(() =>
        store.upsertSession({
          sessionKey: "not-a-key",
          source: "codex",
          device: "laptop",
          startedAt,
          updatedAt,
        }),
      ).toThrow();
      expect(() =>
        store.upsertSession({
          sessionKey: key(2),
          source: "",
          device: "laptop",
          startedAt,
          updatedAt,
        }),
      ).toThrow(YouBrainError);
    });
  });

  it("lists today's sessions in a caller-supplied time zone", () => {
    withStore((store) => {
      const rows = [
        session(1, "2026-07-19T15:00:00.000Z"),
        session(2, "2026-07-20T00:30:00.000+08:00", { title: "offset" }),
        session(3, "2026-07-20T02:00:00.000Z", { title: "utc-morning" }),
        session(4, "2026-07-20T16:00:00.000Z", { title: "boundary" }),
        session(6, "2026-07-20T08:00:00.000Z"),
        session(5, "2026-07-20T08:00:00.000Z"),
      ];
      for (const row of rows) store.upsertSession(row);
      const now = "2026-07-20T01:00:00.000Z";
      const shanghai = store
        .listTodaySessions({ timeZone: "Asia/Shanghai", now })
        .map((row) => row.sessionKey);
      expect(shanghai).toEqual([key(5), key(6), key(3), key(2)]);
      const utc = store
        .listTodaySessions({ timeZone: "UTC", now: new Date(now) })
        .map((row) => row.sessionKey);
      expect(utc).toEqual([key(4), key(5), key(6), key(3)]);
      expect(store.getSession(key(2))?.updatedAt).toBe("2026-07-20T00:30:00.000+08:00");
      expect(() => store.listTodaySessions({ timeZone: "Not/AZone", now })).toThrow(YouBrainError);
      expect(() => store.listTodaySessions({ timeZone: "UTC", now: "yesterday" })).toThrow(
        YouBrainError,
      );
      expect(() => store.listTodaySessions({ timeZone: "Asia/Shanghai" })).not.toThrow();
    });
  });

  it("computes zoned midnights across DST", () => {
    expect(zonedDayRange(new Date("2026-07-20T01:00:00.000Z"), "Asia/Shanghai")).toEqual({
      startMs: Date.parse("2026-07-19T16:00:00.000Z"),
      endMs: Date.parse("2026-07-20T16:00:00.000Z"),
    });
    expect(zonedDayRange(new Date("2026-03-08T18:00:00.000Z"), "America/New_York")).toEqual({
      startMs: Date.parse("2026-03-08T05:00:00.000Z"),
      endMs: Date.parse("2026-03-09T04:00:00.000Z"),
    });
    expect(zonedDayRange(new Date("2026-11-01T12:00:00.000Z"), "America/New_York")).toEqual({
      startMs: Date.parse("2026-11-01T04:00:00.000Z"),
      endMs: Date.parse("2026-11-02T05:00:00.000Z"),
    });
    expect(() => zonedDayRange(new Date("nope"), "UTC")).toThrow(YouBrainError);
  });

  it("includes the New York spring-forward day and excludes its edges", () => {
    withStore((store) => {
      store.upsertSession(session(1, "2026-03-08T04:30:00.000Z"));
      store.upsertSession(session(2, "2026-03-08T05:30:00.000Z"));
      store.upsertSession(session(3, "2026-03-09T03:30:00.000Z"));
      store.upsertSession(session(4, "2026-03-09T04:30:00.000Z"));
      const keys = store
        .listTodaySessions({
          timeZone: "America/New_York",
          now: "2026-03-08T18:00:00.000Z",
        })
        .map((row) => row.sessionKey);
      expect(keys).toEqual([key(3), key(2)]);
    });
  });

  it("queues, leases, and acks outbox items in created order", () => {
    withStore((store) => {
      store.enqueueOutbox({
        id: "a",
        kind: "event",
        payload: { n: 1 },
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      store.enqueueOutbox({
        id: "b",
        kind: "upload",
        payload: { n: 2 },
        createdAt: "2026-07-01T00:00:01.000Z",
      });
      expect(store.dequeueOutbox(0)).toEqual([]);
      const first = store.dequeueOutbox(1);
      expect(first.map((row) => row.id)).toEqual(["a"]);
      expect(first[0]).toMatchObject({ status: "inflight", attempts: 1, payload: { n: 1 } });
      expect(store.dequeueOutbox(5).map((row) => row.id)).toEqual(["b"]);
      expect(store.dequeueOutbox(5)).toEqual([]);
      expect(store.ackOutbox(["a", "missing"])).toBe(1);
      expect(store.getOutbox("a")).toMatchObject({ status: "acked" });
      expect(store.getOutbox("a")?.ackedAt).toEqual(expect.any(String));
      expect(store.ackOutbox(["a"])).toBe(0);
      expect(() =>
        store.enqueueOutbox({
          id: "a",
          kind: "event",
          payload: { n: 3 },
          createdAt: ISO,
        }),
      ).toThrow(YouBrainError);
    });
  });

  it("reads and writes cursors, devices, portraits, and reminders", () => {
    withStore((store) => {
      expect(store.getCursor("capture")).toBeNull();
      store.setCursor("capture", "1");
      store.setCursor("capture", "2");
      expect(store.getCursor("capture")).toBe("2");
      store.setCursor("webinbox:bbb", "web-b");
      store.setCursor("webinbox:aaa", "web-a");
      store.setCursor("web-other", "no");
      expect(store.listCursors("webinbox:")).toEqual([
        { key: "webinbox:aaa", value: "web-a" },
        { key: "webinbox:bbb", value: "web-b" },
      ]);
      expect(store.listCursors("missing")).toEqual([]);

      const device: DeviceRecord = {
        deviceId: "11111111-1111-4111-8111-111111111111",
        displayName: "Mac",
        kind: "desktop",
        platform: "darwin",
        appVersion: "0.1.0",
        protocolVersion: 1,
        capabilities: ["capture", "refine"],
        lastSeenAt: ISO,
        lastActiveAt: ISO,
      };
      store.upsertDevice(device);
      store.upsertDevice({ ...device, displayName: "MacBook" });
      expect(store.getDevice(device.deviceId)?.displayName).toBe("MacBook");
      expect(store.listDevices()).toHaveLength(1);

      store.upsertPortrait({
        variant: "work",
        path: "portrait/work.md",
        version: "v1",
        updatedAt: ISO,
      });
      store.upsertPortrait({
        variant: "life",
        path: "portrait/life.md",
        version: "v1",
        updatedAt: ISO,
      });
      expect(store.listPortraits().map((row) => row.variant)).toEqual(["life", "work"]);
      expect(store.getPortrait("work")?.path).toBe("portrait/work.md");

      store.upsertReminder({
        reminderId: "r1",
        kind: "follow_up",
        topicId: "topic-1",
        text: "ping",
        status: "open",
        until: "2026-07-21T00:00:00.000Z",
        issuedAt: ISO,
        updatedAt: ISO,
      });
      store.upsertReminder({
        reminderId: "r1",
        kind: "follow_up",
        topicId: null,
        text: "ping",
        status: "done",
        until: null,
        issuedAt: ISO,
        updatedAt: "2026-07-21T00:00:00.000Z",
      });
      expect(store.listReminders()).toEqual([
        {
          reminderId: "r1",
          kind: "follow_up",
          topicId: null,
          text: "ping",
          status: "done",
          until: null,
          issuedAt: ISO,
          updatedAt: "2026-07-21T00:00:00.000Z",
        },
      ]);
    });
  });

  it("replaces derived rows without deleting capture columns or events", () => {
    withStore((store) => {
      const updatedAt = "2026-07-19T16:30:00.000Z";
      store.upsertSession({
        sessionKey: key(1),
        source: "codex",
        device: "laptop",
        startedAt: "2026-07-19T16:00:00.000Z",
        updatedAt,
        msgCount: 12,
        fileId: "capture-file",
        title: "capture",
      });
      const event = createEvent({
        type: "topic.created",
        data: { topicId: "topic-1", name: "Alpha", aliases: ["a"] },
        device: "dev-a",
        ts: "2026-07-01T00:00:00.000Z",
        seq: 1,
      });
      store.replaceDerived({
        topics: [
          {
            topicId: "topic-1",
            name: "Alpha",
            aliases: ["a"],
            status: "active",
            statusBy: "auto",
            summary: "s",
            nextStep: "n",
            lastActive: updatedAt,
            mergedInto: null,
            createdTs: event.ts,
            lastUserOpAt: null,
            userLocked: false,
          },
          {
            topicId: "topic-old",
            name: "Old",
            aliases: [],
            status: "done",
            statusBy: "user",
            summary: "",
            nextStep: "",
            lastActive: null,
            mergedInto: "topic-1",
            createdTs: event.ts,
            lastUserOpAt: null,
            userLocked: true,
          },
        ],
        sessions: [
          {
            sessionKey: key(1),
            source: "codex",
            fileId: null,
            title: "Title",
            summary: "Sum",
            refinedUpTo: 4,
            topicId: "topic-1",
          },
        ],
        conclusions: [
          {
            conclusionId: "c1",
            topicId: "topic-1",
            sessionKey: key(1),
            text: "done",
            ts: event.ts,
          },
        ],
        todos: [
          {
            todoId: "t1",
            topicId: "topic-1",
            sessionKey: key(1),
            text: "ship",
            status: "open",
            statusBy: "auto",
            confidence: 0.5,
            ts: event.ts,
            userLocked: false,
          },
        ],
        events: [event],
      });
      expect(store.getSession(key(1))).toMatchObject({
        device: "laptop",
        startedAt: "2026-07-19T16:00:00.000Z",
        updatedAt,
        msgCount: 12,
        fileId: "capture-file",
        title: "Title",
        summary: "Sum",
        refinedUpTo: 4,
        topicId: "topic-1",
      });
      expect(store.listTopics({ liveOnly: true }).map((topic) => topic.topicId)).toEqual([
        "topic-1",
      ]);
      expect(store.getTopic("topic-old")?.userLocked).toBe(true);
      expect(store.listConclusions()).toHaveLength(1);
      expect(store.listTodos()[0]?.text).toBe("ship");
      expect(store.listEvents().map((item) => item.id)).toEqual([event.id]);

      const later = createEvent({
        type: "topic.renamed",
        data: { topicId: "topic-1", name: "Beta", aliases: ["b"] },
        device: "dev-b",
        ts: "2026-07-02T00:00:00.000Z",
        seq: 1,
      });
      store.replaceDerived({
        topics: [],
        sessions: [],
        conclusions: [],
        todos: [],
        events: [event, later],
      });
      expect(store.listTopics()).toEqual([]);
      expect(store.listConclusions()).toEqual([]);
      expect(store.listTodos()).toEqual([]);
      expect(store.getSession(key(1))).toMatchObject({
        device: "laptop",
        title: "Title",
        topicId: null,
        msgCount: 12,
        updatedAt,
      });
      expect(store.listEvents().map((item) => item.type)).toEqual([
        "topic.created",
        "topic.renamed",
      ]);
    });
  });

  it("lists events of the requested types in the same order as the full log", () => {
    withStore((store) => {
      const created = createEvent({
        type: "topic.created",
        data: { topicId: "topic-1", name: "Alpha", aliases: [] },
        device: "dev-a",
        ts: "2026-07-01T00:00:00.000Z",
        seq: 1,
      });
      const correction = createEvent({
        type: "portrait.correction",
        data: { correctionId: "c1", variant: "full", section: "语气", text: "改短" },
        device: "dev-a",
        ts: "2026-07-02T00:00:00.000Z",
        seq: 1,
      });
      const renamed = createEvent({
        type: "topic.renamed",
        data: { topicId: "topic-1", name: "Beta", aliases: [] },
        device: "dev-b",
        ts: "2026-07-02T00:00:00.000Z",
        seq: 2,
      });
      const applied = createEvent({
        type: "portrait.correction_applied",
        data: { correctionId: "c1", snapshot: "JOHN-DIGITAL-TWIN-v1.3.4-2026-10-18.md" },
        device: "dev-a",
        ts: "2026-07-03T00:00:00.000Z",
        seq: 1,
      });
      store.replaceDerived({
        topics: [],
        sessions: [],
        conclusions: [],
        todos: [],
        events: [applied, created, renamed, correction],
      });
      const wanted = ["portrait.correction", "portrait.correction_applied"] as const;
      expect(store.listEventsByType(wanted).map((item) => item.id)).toEqual(
        store
          .listEvents()
          .filter((item) => item.type === "portrait.correction" || item.type === "portrait.correction_applied")
          .map((item) => item.id),
      );
      expect(store.listEventsByType(wanted).map((item) => item.type)).toEqual([
        "portrait.correction",
        "portrait.correction_applied",
      ]);
      expect(store.listEventsByType([])).toEqual([]);
      expect(store.listEventsByType(["topic.created", "topic.created"]).map((item) => item.id)).toEqual([
        created.id,
      ]);
      expect(store.listEventsByType(["session.refined"])).toEqual([]);
    });
  });
});
