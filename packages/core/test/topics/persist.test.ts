import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { SqliteStore } from "../../src/store/index.js";
import { emptyTopicBook, foldEvents, persistTopicBook } from "../../src/topics/index.js";
import { KEY_1, KEY_2, buildEvent, plus } from "./helpers.js";

const UPDATED_AT = "2026-07-19T16:30:00.000Z";

function withStore(run: (store: SqliteStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "you-brain-persist-"));
  const store = new SqliteStore(join(directory, "brain.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("persist topic book", () => {
  it("writes derived rows, keeps capture columns, and retains events", () => {
    withStore((store) => {
      store.upsertSession({
        sessionKey: KEY_1,
        source: "codex",
        device: "laptop",
        startedAt: "2026-07-19T16:00:00.000Z",
        updatedAt: UPDATED_AT,
        msgCount: 12,
        fileId: "capture-file",
      });
      const book = foldEvents([
        buildEvent({
          type: "topic.created",
          data: { topicId: "topic-1", name: "Design", aliases: [] },
          device: "dev-a",
          ts: plus(1),
          seq: 1,
        }),
        buildEvent({
          type: "session.refined",
          data: {
            sessionKey: KEY_1,
            fileId: "refined-file",
            source: "codex",
            title: "Refined",
            summary: "A summary",
            refinedUpTo: 4,
          },
          device: "dev-a",
          ts: plus(2),
          seq: 2,
        }),
        buildEvent({
          type: "topic.assigned",
          data: { topicId: "topic-1", sessionKey: KEY_1 },
          device: "dev-a",
          ts: plus(3),
          seq: 3,
        }),
        buildEvent({
          type: "conclusion.added",
          data: {
            conclusionId: "c1",
            topicId: "topic-1",
            text: "shipped",
            sessionKey: KEY_1,
          },
          device: "dev-a",
          ts: plus(4),
          seq: 4,
        }),
        buildEvent({
          type: "todo.added",
          data: {
            todoId: "t1",
            topicId: "topic-1",
            text: "follow up",
            sessionKey: KEY_1,
            confidence: 0.5,
          },
          device: "dev-a",
          ts: plus(5),
          seq: 5,
        }),
        buildEvent({
          type: "session.refined",
          data: {
            sessionKey: KEY_2,
            fileId: "f2",
            source: "cursor",
            title: "only-event",
            summary: "from events",
            refinedUpTo: 1,
          },
          device: "dev-b",
          ts: plus(6),
          seq: 1,
        }),
      ]);

      persistTopicBook(store, book);
      expect(store.getSession(KEY_1)).toMatchObject({
        device: "laptop",
        startedAt: "2026-07-19T16:00:00.000Z",
        updatedAt: UPDATED_AT,
        msgCount: 12,
        fileId: "refined-file",
        title: "Refined",
        summary: "A summary",
        refinedUpTo: 4,
        topicId: "topic-1",
        source: "codex",
      });
      expect(store.getTopic("topic-1")?.lastActive).toBe(UPDATED_AT);
      expect(store.listConclusions().map((row) => row.text)).toEqual(["shipped"]);
      expect(store.listTodos().map((row) => row.text)).toEqual(["follow up"]);
      expect(store.getSession(KEY_2)).toEqual({
        sessionKey: KEY_2,
        source: "cursor",
        device: "",
        fileId: "f2",
        title: "only-event",
        summary: "from events",
        startedAt: null,
        updatedAt: null,
        msgCount: 0,
        refinedUpTo: 1,
        topicId: null,
      });
      const today = store.listTodaySessions({
        timeZone: "Asia/Shanghai",
        now: "2026-07-20T01:00:00.000Z",
      });
      expect(today.map((row) => row.sessionKey)).toEqual([KEY_1]);

      const eventCount = store.listEvents().length;
      persistTopicBook(store, book);
      expect(store.listEvents()).toHaveLength(eventCount);

      const other = foldEvents([
        buildEvent({
          type: "topic.created",
          data: { topicId: "topic-2", name: "Other", aliases: [] },
          device: "dev-c",
          ts: plus(20),
          seq: 1,
        }),
      ]);
      persistTopicBook(store, other);
      expect(store.listTopics().map((topic) => topic.topicId)).toEqual(["topic-2"]);
      expect(store.listConclusions()).toEqual([]);
      expect(store.listTodos()).toEqual([]);
      expect(store.listEvents()).toHaveLength(eventCount + 1);
      expect(store.getSession(KEY_1)?.topicId).toBeNull();
      expect(store.getSession(KEY_1)?.title).toBe("Refined");

      persistTopicBook(store, emptyTopicBook());
      expect(store.listTopics()).toEqual([]);
      expect(store.listEvents()).toHaveLength(eventCount + 1);
      expect(store.getSession(KEY_1)).toMatchObject({
        device: "laptop",
        title: "Refined",
        topicId: null,
        msgCount: 12,
        updatedAt: UPDATED_AT,
      });
      expect(
        store
          .listTodaySessions({
            timeZone: "Asia/Shanghai",
            now: "2026-07-20T01:00:00.000Z",
          })
          .map((row) => row.sessionKey),
      ).toEqual([KEY_1]);
    });
  });
});
