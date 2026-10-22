import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EventOf, EventType } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { createDaemonClient } from "../../src/http/client.js";
import type { HttpDeps } from "../../src/http/deps.js";
import { createStoreReaders } from "../../src/http/queries.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import type { DaemonEvent } from "../../src/http/types.js";
import { EventLog } from "../../src/sync/event-log.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { applyEvents, foldEvents } from "../../src/topics/fold.js";
import { persistTopicBook } from "../../src/topics/persist.js";
import { KEY_1, buildEvent } from "../topics/helpers.js";

const NOW = "2026-10-21T16:30:00.000Z";
const TOPIC = "topic-1";

function seed(store: SqliteStore): void {
  const events = [
    buildEvent({
      type: "topic.created",
      data: { topicId: TOPIC, name: "方案", aliases: [] },
      device: "dev-a",
      ts: "2026-10-01T00:00:00.000Z",
      seq: 1,
    }),
    buildEvent({
      type: "topic.assigned",
      data: { topicId: TOPIC, sessionKey: KEY_1 },
      device: "dev-a",
      ts: "2026-10-01T00:00:00.000Z",
      seq: 2,
    }),
    buildEvent({
      type: "todo.added",
      data: {
        todoId: "todo-1",
        topicId: TOPIC,
        text: "补测试",
        sessionKey: KEY_1,
        confidence: 0.9,
      },
      device: "dev-a",
      ts: "2026-10-01T00:00:00.000Z",
      seq: 3,
    }),
    buildEvent({
      type: "reminder.issued",
      data: {
        reminderId: "stale:topic-1:2026-10-01",
        kind: "stale",
        topicId: TOPIC,
        text: "「方案」已 7 天没有新进展，还有 1 件待办未完成。",
      },
      device: "dev-main",
      ts: "2026-10-21T08:00:00.000Z",
      seq: 1,
    }),
    buildEvent({
      type: "reminder.issued",
      data: {
        reminderId: "morning:2026-10-21",
        kind: "morning_digest",
        topicId: null,
        text: "昨日没有新结论。\n未完成待办 1 件。",
      },
      device: "dev-main",
      ts: "2026-10-21T08:05:00.000Z",
      seq: 2,
    }),
  ];
  store.upsertSession({
    sessionKey: KEY_1,
    source: "codex",
    device: "laptop",
    startedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    topicId: TOPIC,
  });
  persistTopicBook(store, foldEvents(events));
}

async function withHttp(
  run: (ctx: { server: DaemonHttpServer; store: SqliteStore; now: { value: string } }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "you-brain-reminder-http-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  const now = { value: NOW };
  seed(store);
  const log = new EventLog(store, "device-http", { now: () => new Date(now.value) });
  const readers = createStoreReaders(store, {
    timeZone: "UTC",
    activeLimit: 10,
    historyDays: 30,
    now: () => new Date(now.value),
  });
  const deps: HttpDeps = {
    today: () => readers.today(),
    topics: (query) => readers.topics(query),
    topic: (id) => readers.topic(id),
    todo: (id) => readers.todo(id),
    portrait: async () => null,
    portraitSnapshots: async () => [],
    portraitCorrections: async () => [],
    search: async (query) => ({
      query: query.query,
      indexStatus: "fresh",
      searchMode: "keyword",
      results: [],
      warnings: [],
    }),
    devices: () => readers.devices(),
    readRoles: async () => {
      throw new Error("unused");
    },
    writeRoles: async () => undefined,
    readConfig: async () => {
      throw new Error("unused");
    },
    writeConfig: async () => undefined,
    status: async () => {
      throw new Error("unused");
    },
    sync: async () => ({ started: false, at: now.value }),
    upload: async () => ({ dryRun: true, scanned: 0, uploaded: 0, warnings: [] }),
    reminders: (all) => readers.reminders(all),
    reminder: (id) => readers.reminder(id),
    reportActivity: async (at) => ({ at }),
    now: () => new Date(now.value),
    events: {
      emit<T extends EventType>(type: T, data: EventOf<T>["data"]) {
        const event = log.allocate(type, data);
        persistTopicBook(store, applyEvents(foldEvents(store.listEvents()), [event]));
      },
    },
  };
  const server = await startDaemonHttp({ dataDir: dir, deps });
  try {
    await run({ server, store, now });
  } finally {
    await server.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function api(server: DaemonHttpServer, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${server.token}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${server.baseUrl}${path}`, { ...init, headers });
}

describe("reminder HTTP", () => {
  it("lists open reminders and applies ignore, snooze, and topic actions", async () => {
    await withHttp(async ({ server, now }) => {
      const client = createDaemonClient({ port: server.port, token: server.token });
      const listed = await client.reminders();
      expect(listed.reminders.map((item) => item.reminderId)).toEqual([
        "morning:2026-10-21",
        "stale:topic-1:2026-10-01",
      ]);
      expect(listed.reminders[1]?.topicName).toBe("方案");

      const missing = await api(server, "/api/actions/reminder", {
        method: "POST",
        body: JSON.stringify({ reminderId: "missing", action: "ignore" }),
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: { code: "NOT_FOUND", message: "提醒不存在" } });

      const refused = await api(server, "/api/actions/reminder", {
        method: "POST",
        body: JSON.stringify({ reminderId: "morning:2026-10-21", action: "done" }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: { code: "INVALID_INPUT", message: "这条提醒只能关闭" },
      });

      if (!client.reminderAction) throw new Error("client reminderAction is missing");
      const seen: DaemonEvent[] = [];
      const controller = new AbortController();
      let markReady: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const pending = client.events(
        (event) => {
          seen.push(event);
          if (event.kind === "ready") markReady();
          if (event.kind === "status") controller.abort();
        },
        { signal: controller.signal },
      );
      await ready;
      const closed = await client.reminderAction({
        reminderId: "morning:2026-10-21",
        action: "ignore",
      });
      expect(closed).toMatchObject({ reminderId: "morning:2026-10-21", status: "dismissed" });
      await pending;
      expect(seen.some((event) => event.kind === "status")).toBe(true);

      const afterIgnore = await client.reminders();
      expect(afterIgnore.reminders.map((item) => item.reminderId)).toEqual(["stale:topic-1:2026-10-01"]);
      const all = await client.reminders(true);
      expect(all.reminders.map((item) => item.status)).toContain("dismissed");

      const snoozed = await client.reminderAction({
        reminderId: "stale:topic-1:2026-10-01",
        action: "snooze",
      });
      expect(snoozed).toMatchObject({
        status: "snoozed",
        until: "2026-10-22T16:30:00.000Z",
      });
      expect((await client.reminders()).reminders).toEqual([]);
      now.value = "2026-10-22T16:30:00.000Z";
      const expired = await client.reminders();
      expect(expired.reminders).toEqual([
        expect.objectContaining({
          reminderId: "stale:topic-1:2026-10-01",
          status: "open",
        }),
      ]);

      const done = await client.reminderAction({
        reminderId: "stale:topic-1:2026-10-01",
        action: "done",
      });
      expect(done.status).toBe("done");
      const topic = await client.topic(TOPIC);
      expect(topic.status).toBe("done");
      expect(topic.statusBy).toBe("user");
    });
  });
});
