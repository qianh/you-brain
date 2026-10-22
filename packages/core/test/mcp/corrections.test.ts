import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDefaultSharedConfig, createEvent, type EventOf, type EventType } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { writeDaemonEndpoint } from "../../src/http/daemon-file.js";
import type { HttpDeps } from "../../src/http/deps.js";
import { createStoreReaders } from "../../src/http/queries.js";
import { startDaemonHttp } from "../../src/http/server.js";
import { createLocalMcpServices } from "../../src/mcp/local.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { portraitCorrectionViews } from "../../src/portrait/corrections.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { EventLog } from "../../src/sync/event-log.js";
import { applyEvents, foldEvents } from "../../src/topics/fold.js";
import { persistTopicBook } from "../../src/topics/persist.js";

const NOW = "2026-07-20T12:00:00.000Z";

function directory(): string {
  return mkdtempSync(join(tmpdir(), "you-brain-mcp-corr-"));
}

function textOf(result: { [key: string]: unknown }): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  const block = content[0] as { text?: unknown } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

async function call(
  services: ReturnType<typeof createLocalMcpServices>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const server = createMcpServer(services);
  const client = new Client({ name: "you-brain-correction-mcp", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

function servicesFor(store: SqliteStore, dataDir: string) {
  return createLocalMcpServices({
    store,
    search: {
      search: async (input) => ({
        query: input.query,
        indexStatus: "fresh",
        searchMode: "keyword",
        results: [],
        warnings: [],
      }),
    },
    drive: new MemoryDrive(),
    portraitDir: dataDir,
    dataDir,
    zone: { timeZone: "UTC", activeLimit: 10, historyDays: 30 },
  });
}

describe("portrait correction MCP", () => {
  it("reads corrections from the local store when the daemon is offline", async () => {
    const dataDir = directory();
    const store = new SqliteStore(join(dataDir, "state.sqlite"));
    const pending = createEvent({
      type: "portrait.correction",
      data: { correctionId: "c-open", variant: "full", section: "语气", text: "改短" },
      device: "dev-a",
      ts: NOW,
      seq: 1,
    });
    const saved = createEvent({
      type: "portrait.correction",
      data: { correctionId: "c-done", variant: "brief", section: "长度", text: "再短" },
      device: "dev-a",
      ts: "2026-07-19T00:00:00.000Z",
      seq: 1,
    });
    const applied = createEvent({
      type: "portrait.correction_applied",
      data: { correctionId: "c-done", snapshot: "JOHN-DIGITAL-TWIN-v1.3.4-2026-10-18.md" },
      device: "dev-a",
      ts: "2026-07-19T01:00:00.000Z",
      seq: 2,
    });
    store.replaceDerived({
      topics: [],
      sessions: [],
      conclusions: [],
      todos: [],
      events: [pending, saved, applied],
    });
    const services = servicesFor(store, dataDir);
    try {
      const listed = await call(services, "get_portrait_corrections", { variant: "full" });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toEqual({
        corrections: portraitCorrectionViews([pending, saved, applied], "full"),
      });
      const rejected = await call(services, "add_portrait_correction", {
        section: "语气",
        text: "改短",
      });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain("DAEMON_NOT_RUNNING");
      expect(textOf(rejected)).not.toContain("at ");
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("forwards a correction to the daemon and returns its validation error", async () => {
    const dataDir = directory();
    const store = new SqliteStore(join(dataDir, "state.sqlite"));
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
    const http = await startDaemonHttp({ dataDir, deps });
    await writeDaemonEndpoint(dataDir, { port: http.port, token: http.token, pid: process.pid });
    const services = servicesFor(store, dataDir);
    try {
      const added = await call(services, "add_portrait_correction", {
        section: "语气",
        text: "改短一点",
      });
      expect(added.isError).not.toBe(true);
      expect(textOf(added)).toContain("不会立刻改写");
      expect(added.structuredContent).toMatchObject({
        ok: true,
        correction: { variant: "full", section: "语气", text: "改短一点", status: "pending" },
      });
      const listed = await call(services, "get_portrait_corrections", {});
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({
        corrections: [{ section: "语气", text: "改短一点", status: "pending" }],
      });
      const rejected = await call(services, "add_portrait_correction", {
        variant: "nope",
        section: "语气",
        text: "改短",
      });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain("无效的数字分身变体");
      expect(textOf(rejected)).not.toContain("at ");
    } finally {
      await http.stop();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
