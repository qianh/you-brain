import { rm } from "node:fs/promises";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import type { DaemonClock } from "../../src/daemon/clock.js";
import type { DrivePort } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import {
  makeDaemonDirs,
  readStatus,
  testClock,
  throwingEmbedder,
  type DaemonDirs,
} from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function inboxFile(id: string, updatedAt: string): Buffer {
  return Buffer.from(
    [
      "---",
      "source: claude-code",
      `conversation_id: ${id}`,
      "device: other-mac",
      "started_at: 2026-10-17T01:00:00.000Z",
      `updated_at: ${updatedAt}`,
      "turn_count: 2",
      "---",
      "",
      "hello",
      "",
    ].join("\n"),
  );
}

function stateDb(dataDir: string): Database {
  const db = new Database(join(dataDir, "state.sqlite"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function sessionFileIds(dataDir: string): string[] {
  const db = stateDb(dataDir);
  try {
    const rows = db.query("SELECT file_id FROM sessions").all() as Array<{ file_id: string | null }>;
    return rows.map((row) => row.file_id ?? "");
  } finally {
    db.close();
  }
}

function pendingIds(dataDir: string): string[] {
  const db = stateDb(dataDir);
  try {
    const row = db
      .query("SELECT value FROM cursors WHERE key = ?")
      .get("inbox.pending") as { value: string } | null;
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value) as Array<{ id?: string }>;
    return parsed.map((item) => item.id ?? "");
  } finally {
    db.close();
  }
}

function cursorValue(dataDir: string, key: string): string | null {
  const db = stateDb(dataDir);
  try {
    const row = db.query("SELECT value FROM cursors WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/** Moves the manual clock without also moving the budget offset layered on top of it. */
async function nextTick(clock: ReturnType<typeof testClock>, daemon: YouBrainDaemon): Promise<void> {
  await clock.advance(1_000);
  await daemon.settled();
}

describe("inbox indexing during a pull", () => {
  it("downloads a remote file once, and again only after it changes", async () => {
    const dirs: DaemonDirs = await makeDaemonDirs("you-brain-inbox-index-");
    roots.push(dirs.root);
    const clock = testClock();
    const memory = new MemoryDrive({ now: () => clock.now() });
    const reads: string[] = [];
    const drive = new Proxy(memory, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          // The search index downloads inbox files too. Only the session indexing is under test.
          if (property === "read" && new Error().stack?.includes("#drainInbox")) reads.push(String(args[0]));
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DrivePort;
    const ids = ["one", "two", "three"];
    const entries = new Map<string, string>();
    for (const id of ids) {
      const entry = await memory.put({
        path: `inbox/other-mac/claude-code/2026/10/${id}.md`,
        bytes: inboxFile(id, "2026-10-17T02:00:00.000Z"),
        mimeType: "text/markdown",
      });
      entries.set(id, entry.id);
    }
    const open = async (): Promise<YouBrainDaemon> => {
      const daemon = await startDaemon({
        homeDir: dirs.homeDir,
        platform: "darwin",
        env: dirs.env,
        hostname: "device-a",
        clock,
        drive,
        llm: null,
        embedder: throwingEmbedder,
        sourceRoots: {},
        watch: false,
        signals: false,
      });
      started.push(daemon);
      await daemon.settled();
      return daemon;
    };
    let daemon = await open();
    const sync = () =>
      fetch(`${daemon.baseUrl}/api/actions/sync`, {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.token}` },
      });
    const inboxReads = () => reads.filter((id) => [...entries.values()].includes(id));

    await sync();
    await nextTick(clock, daemon);
    expect(inboxReads().sort()).toEqual([...entries.values()].sort());

    // A restart that lost the sync cursor pulls everything again. The files are not downloaded again.
    await daemon.stop();
    const state = new Database(join(dirs.dataDir, "state.sqlite"));
    state.run("DELETE FROM cursors WHERE key = 'sync.drive'");
    state.close();
    daemon = await open();
    reads.length = 0;
    await sync();
    await daemon.settled();
    expect(inboxReads()).toEqual([]);

    // A newer version of one file is read again, and only that one.
    await clock.advance(60_000);
    await memory.update(entries.get("two") ?? "", inboxFile("two", "2026-10-17T03:00:00.000Z"));
    reads.length = 0;
    await sync();
    await nextTick(clock, daemon);
    expect(inboxReads()).toEqual([entries.get("two") ?? ""]);
  });
});

describe("inbox index queue", () => {
  it("sets lastSyncAt before the inbox is fully read, then finishes across ticks", async () => {
    const dirs = await makeDaemonDirs("you-brain-inbox-budget-");
    roots.push(dirs.root);
    const clock = testClock();
    let spent = 0;
    const budgetClock: DaemonClock = {
      now: () => new Date(clock.nowMs() + spent),
      nowMs: () => clock.nowMs() + spent,
      schedule: (ms, fn) => clock.schedule(ms, fn),
    };
    const memory = new MemoryDrive({ now: () => budgetClock.now() });
    const inboxIds = new Set<string>();
    const inboxReads: string[] = [];
    const drive = new Proxy(memory, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "read" && inboxIds.has(String(args[0]))) {
            inboxReads.push(String(args[0]));
            // Eight parallel reads push one pass past the 15s inbox budget.
            if (new Error().stack?.includes("#drainInbox")) spent += 2_000;
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DrivePort;
    const count = 40;
    for (let index = 0; index < count; index += 1) {
      const id = `budget-${String(index).padStart(2, "0")}`;
      const entry = await memory.put({
        path: `inbox/other-mac/claude-code/2026/10/${id}.md`,
        bytes: inboxFile(id, "2026-10-18T02:00:00.000Z"),
        mimeType: "text/markdown",
      });
      inboxIds.add(entry.id);
    }
    const daemon = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "device-a",
      clock: budgetClock,
      drive,
      llm: null,
      embedder: throwingEmbedder,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    started.push(daemon);
    await daemon.settled();
    const synced = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(synced.ok).toBe(true);
    const status = await readStatus(daemon);
    expect(status.sync.lastSyncAt).not.toBeNull();
    expect(inboxReads.length).toBeLessThan(count);

    await nextTick(clock, daemon);
    const midway = sessionFileIds(dirs.dataDir);
    expect(midway.length).toBeGreaterThan(0);
    expect(midway.length).toBeLessThan(count);

    for (let tick = 0; tick < 20 && sessionFileIds(dirs.dataDir).length < count; tick += 1) {
      await nextTick(clock, daemon);
    }
    expect(sessionFileIds(dirs.dataDir)).toHaveLength(count);
    expect(pendingIds(dirs.dataDir)).toEqual([]);
  });

  it("resumes the persisted queue after a restart and does not reread finished files", async () => {
    const dirs = await makeDaemonDirs("you-brain-inbox-resume-");
    roots.push(dirs.root);
    const clock = testClock();
    let spent = 0;
    const budgetClock: DaemonClock = {
      now: () => new Date(clock.nowMs() + spent),
      nowMs: () => clock.nowMs() + spent,
      schedule: (ms, fn) => clock.schedule(ms, fn),
    };
    const memory = new MemoryDrive({ now: () => budgetClock.now() });
    const drainReads: string[] = [];
    const drive = new Proxy(memory, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "read" && new Error().stack?.includes("#drainInbox")) {
            drainReads.push(String(args[0]));
            spent += 2_000;
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DrivePort;
    const count = 40;
    for (let index = 0; index < count; index += 1) {
      const id = `resume-${String(index).padStart(2, "0")}`;
      await memory.put({
        path: `inbox/other-mac/claude-code/2026/10/${id}.md`,
        bytes: inboxFile(id, "2026-10-18T02:00:00.000Z"),
        mimeType: "text/markdown",
      });
    }
    const open = async (): Promise<YouBrainDaemon> => {
      const daemon = await startDaemon({
        homeDir: dirs.homeDir,
        platform: "darwin",
        env: dirs.env,
        hostname: "device-a",
        clock: budgetClock,
        drive,
        llm: null,
        embedder: throwingEmbedder,
        sourceRoots: {},
        watch: false,
        signals: false,
      });
      started.push(daemon);
      await daemon.settled();
      return daemon;
    };
    let daemon = await open();
    const synced = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(synced.ok).toBe(true);
    await nextTick(clock, daemon);
    const finished = new Set(drainReads);
    expect(finished.size).toBeGreaterThan(0);
    expect(finished.size).toBeLessThan(count);
    expect(cursorValue(dirs.dataDir, "sync.drive")).not.toBeNull();
    const waiting = pendingIds(dirs.dataDir);
    expect(waiting.length).toBe(count - finished.size);
    for (const id of finished) expect(waiting).not.toContain(id);

    await daemon.stop();
    drainReads.length = 0;
    daemon = await open();
    expect(cursorValue(dirs.dataDir, "sync.drive")).not.toBeNull();
    expect(pendingIds(dirs.dataDir).length).toBe(waiting.length);
    for (let tick = 0; tick < 20 && sessionFileIds(dirs.dataDir).length < count; tick += 1) {
      await nextTick(clock, daemon);
    }
    expect(sessionFileIds(dirs.dataDir)).toHaveLength(count);
    expect(pendingIds(dirs.dataDir)).toEqual([]);
    for (const id of drainReads) expect(finished.has(id)).toBe(false);
  });

  it("keeps a file whose read failed and indexes it on the next pass", async () => {
    const dirs = await makeDaemonDirs("you-brain-inbox-retry-");
    roots.push(dirs.root);
    const clock = testClock();
    const memory = new MemoryDrive({ now: () => clock.now() });
    const entries: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const id = `retry-${String(index).padStart(2, "0")}`;
      const entry = await memory.put({
        path: `inbox/other-mac/claude-code/2026/10/${id}.md`,
        bytes: inboxFile(id, "2026-10-18T02:00:00.000Z"),
        mimeType: "text/markdown",
      });
      entries.push(entry.id);
    }
    const blocked = entries[0] ?? "";
    let fail = true;
    const drive = new Proxy(memory, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (
            property === "read" &&
            String(args[0]) === blocked &&
            fail &&
            new Error().stack?.includes("#drainInbox")
          ) {
            throw new Error("inbox read failed");
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DrivePort;
    const daemon = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "device-a",
      clock,
      drive,
      llm: null,
      embedder: throwingEmbedder,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    started.push(daemon);
    await daemon.settled();
    const synced = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(synced.ok).toBe(true);
    await nextTick(clock, daemon);

    const stored = sessionFileIds(dirs.dataDir);
    expect(stored).toHaveLength(7);
    expect(stored).not.toContain(blocked);
    expect(pendingIds(dirs.dataDir)).toEqual([blocked]);

    fail = false;
    await nextTick(clock, daemon);
    expect(sessionFileIds(dirs.dataDir)).toHaveLength(8);
    expect(sessionFileIds(dirs.dataDir)).toContain(blocked);
    expect(pendingIds(dirs.dataDir)).toEqual([]);
  });
});
