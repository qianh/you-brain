import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultSharedConfig, type EventOf, type EventType } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { createDaemonClient, DaemonClientError } from "../../src/http/client.js";
import type { HttpDeps } from "../../src/http/deps.js";
import { createStoreReaders } from "../../src/http/queries.js";
import { startDaemonHttp, type DaemonHttpServer } from "../../src/http/server.js";
import { portraitCorrectionViews } from "../../src/portrait/corrections.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { EventLog } from "../../src/sync/event-log.js";
import { applyEvents, foldEvents } from "../../src/topics/fold.js";
import { persistTopicBook } from "../../src/topics/persist.js";

const NOW = "2026-10-21T16:30:00.000Z";

async function withHttp(
  run: (ctx: { server: DaemonHttpServer; store: SqliteStore; log: EventLog }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "you-brain-correction-http-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  const log = new EventLog(store, "device-http", { now: () => new Date(NOW) });
  const readers = createStoreReaders(store, {
    timeZone: "UTC",
    activeLimit: 10,
    historyDays: 30,
    now: () => new Date(NOW),
  });
  const deps: HttpDeps = {
    today: () => readers.today(),
    topics: (query) => readers.topics(query),
    topic: (id) => readers.topic(id),
    todo: (id) => readers.todo(id),
    portrait: async () => null,
    portraitSnapshots: async () => [],
    portraitCorrections: async (variant) =>
      portraitCorrectionViews(
        store.listEventsByType(["portrait.correction", "portrait.correction_applied"]),
        variant,
      ),
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
    readConfig: async () => createDefaultSharedConfig(),
    writeConfig: async () => undefined,
    status: async () => {
      throw new Error("unused");
    },
    sync: async () => ({ started: false, at: NOW }),
    upload: async () => ({ dryRun: true, scanned: 0, uploaded: 0, warnings: [] }),
    reminders: (all) => readers.reminders(all),
    reminder: (id) => readers.reminder(id),
    reportActivity: async (at) => ({ at }),
    now: () => new Date(NOW),
    events: {
      emit<T extends EventType>(type: T, data: EventOf<T>["data"]) {
        const event = log.allocate(type, data);
        persistTopicBook(store, applyEvents(foldEvents(store.listEvents()), [event]));
      },
    },
  };
  const server = await startDaemonHttp({ dataDir: dir, deps });
  try {
    await run({ server, store, log });
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

describe("portrait correction HTTP", () => {
  it("stores a pending correction and shows it as applied after the event arrives", async () => {
    await withHttp(async ({ server, store, log }) => {
      const client = createDaemonClient({ port: server.port, token: server.token });
      const added = await client.addPortraitCorrection({
        section: " 语气 ",
        text: " 把语气改短 ",
      });
      expect(added.ok).toBe(true);
      expect(added.correction).toMatchObject({
        variant: "full",
        section: "语气",
        text: "把语气改短",
        status: "pending",
        createdAt: NOW,
      });
      expect(added.correction.snapshot).toBeUndefined();
      const written = store
        .listEventsByType(["portrait.correction"])
        .find((event) => event.type === "portrait.correction");
      expect(written?.type).toBe("portrait.correction");
      if (written?.type === "portrait.correction") {
        expect(written.data).toEqual({
          correctionId: added.correction.correctionId,
          variant: "full",
          section: "语气",
          text: "把语气改短",
        });
      }

      const listed = await client.portraitCorrections("full");
      expect(listed.corrections).toEqual([added.correction]);
      const brief = await client.addPortraitCorrection({
        variant: "brief",
        section: "长度",
        text: "再短一点",
      });
      expect((await client.portraitCorrections("full")).corrections.map((item) => item.correctionId)).toEqual([
        added.correction.correctionId,
      ]);
      const all = await client.portraitCorrections();
      expect(new Set(all.corrections.map((item) => item.correctionId))).toEqual(
        new Set([brief.correction.correctionId, added.correction.correctionId]),
      );

      const snapshot = "JOHN-DIGITAL-TWIN-v1.3.4-2026-10-18.md";
      const applied = log.allocate("portrait.correction_applied", {
        correctionId: added.correction.correctionId,
        snapshot,
      });
      persistTopicBook(store, applyEvents(foldEvents(store.listEvents()), [applied]));
      const after = await client.portraitCorrections("full");
      expect(after.corrections).toEqual([
        { ...added.correction, status: "applied", snapshot },
      ]);
    });
  });

  it("rejects an empty section, an oversized text, and an unknown variant", async () => {
    await withHttp(async ({ server }) => {
      const empty = await api(server, "/api/portrait/corrections", {
        method: "POST",
        body: JSON.stringify({ section: "   ", text: "有内容" }),
      });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({
        error: { code: "INVALID_INPUT", message: "「哪一部分」需要 1 到 80 个字" },
      });

      const longText = await api(server, "/api/portrait/corrections", {
        method: "POST",
        body: JSON.stringify({ section: "语气", text: "字".repeat(1001) }),
      });
      expect(longText.status).toBe(400);
      expect(await longText.json()).toEqual({
        error: { code: "INVALID_INPUT", message: "「应该怎么改」需要 1 到 1000 个字" },
      });

      for (const variant of ["nope", "../x"]) {
        const rejected = await api(server, "/api/portrait/corrections", {
          method: "POST",
          body: JSON.stringify({ variant, section: "语气", text: "改短" }),
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({
          error: { code: "INVALID_INPUT", message: "无效的数字分身变体" },
        });
      }

      const listed = await api(server, "/api/portrait/corrections?variant=nope");
      expect(listed.status).toBe(400);
      const client = createDaemonClient({ port: server.port, token: server.token });
      await expect(client.portraitCorrections("full")).resolves.toEqual({ corrections: [] });
      try {
        await client.addPortraitCorrection({ variant: "nope", section: "语气", text: "改短" });
        throw new Error("expected INVALID_INPUT");
      } catch (error) {
        expect(error).toBeInstanceOf(DaemonClientError);
        if (error instanceof DaemonClientError) {
          expect(error.status).toBe(400);
          expect(error.code).toBe("INVALID_INPUT");
          expect(error.message).toBe("无效的数字分身变体");
        }
      }
    });
  });
});
