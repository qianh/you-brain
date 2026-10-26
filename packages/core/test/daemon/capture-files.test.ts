import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { makeDaemonDirs, readStatus, testClock, type DaemonDirs } from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function claudeLine(sessionId: string, text: string): string {
  return JSON.stringify({
    type: "user",
    isSidechain: false,
    sessionId,
    timestamp: "2026-10-18T02:00:00.000Z",
    message: { role: "user", content: text },
  });
}

function cursorValue(dataDir: string, key: string): string | null {
  const db = new Database(join(dataDir, "state.sqlite"));
  try {
    const row = db.query("SELECT value FROM cursors WHERE key = ?").get(key) as
      | { value: string }
      | null;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

async function open(
  dirs: DaemonDirs,
  extra: Parameters<typeof startDaemon>[0],
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock: testClock(),
    llm: null,
    watch: false,
    signals: false,
    ...extra,
  });
  started.push(daemon);
  await daemon.settled();
  return daemon;
}

describe("capture file fingerprints", () => {
  it("persists them so a restart does not re-parse unchanged files", async () => {
    const dirs = await makeDaemonDirs("you-brain-capture-files-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeFile(join(dirs.sourceDir, "one.jsonl"), `${claudeLine("one", "first question")}\n`);
    await writeFile(join(dirs.sourceDir, "two.jsonl"), `${claudeLine("two", "second question")}\n`);

    const options = {
      clock,
      drive,
      sourceRoots: { "claude-code": [dirs.sourceDir] },
    };
    const first = await open(dirs, options);
    await first.stop();
    started.splice(started.indexOf(first), 1);

    // The scan wrote a fingerprint per file plus the session key it belongs to.
    const stored = cursorValue(dirs.dataDir, "capture.files");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored ?? "[]") as Array<[string, { stamp: string; key: string | null }]>;
    expect(parsed).toHaveLength(2);
    const paths = parsed.map(([path]) => path).sort();
    expect(paths).toEqual([
      join(dirs.sourceDir, "one.jsonl"),
      join(dirs.sourceDir, "two.jsonl"),
    ]);
    expect(parsed.every(([, cursor]) => cursor.stamp.startsWith("f:"))).toBe(true);
    expect(parsed.every(([, cursor]) => typeof cursor.key === "string")).toBe(true);
  });

  it("does not re-upload an unchanged session after a restart", async () => {
    const dirs = await makeDaemonDirs("you-brain-capture-files-noupload-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeFile(join(dirs.sourceDir, "one.jsonl"), `${claudeLine("one", "first question")}\n`);

    const puts: string[] = [];
    const tracked = new Proxy(drive, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          // A new session is created, an existing one updated; count both as a write.
          if (property === "create" || property === "update" || property === "put") {
            const first = args[0] as { path?: string } | string;
            puts.push(typeof first === "string" ? property : String(first.path ?? property));
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as MemoryDrive;

    const options = {
      clock,
      drive: tracked,
      sourceRoots: { "claude-code": [dirs.sourceDir] },
    };
    const first = await open(dirs, options);
    // Force the upload instead of waiting out the idle window tick by tick.
    const uploaded = await fetch(`${first.baseUrl}/api/actions/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sources: ["claude-code"] }),
    });
    expect(uploaded.ok).toBe(true);
    expect(puts.filter((path) => path.startsWith("inbox/")).length).toBeGreaterThan(0);
    await first.stop();
    started.splice(started.indexOf(first), 1);

    puts.length = 0;
    const second = await open(dirs, options);
    await clock.advance(2_000);
    await second.settled();
    // The startup scan itself must not re-parse: the fingerprints are read back and the
    // restored metadata is what lets each hit attach without touching the file.
    const startup = await readStatus(second);
    expect(startup.capture?.parsed).toBe(0);
    // The file did not change, so the restore marks it uploaded and nothing is written.
    expect(puts.filter((path) => path.startsWith("inbox/"))).toEqual([]);

    // A restart must still see the session: without the restore, an unchanged file has no
    // metadata to attach to and is dropped, which would leave the session unmanaged.
    const dryRun = await fetch(`${second.baseUrl}/api/actions/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${second.token}`, "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true, sources: ["claude-code"] }),
    });
    const body = (await dryRun.json()) as { scanned: number };
    expect(body.scanned).toBe(1);
  });

  it("queues a captured session that never reached Drive", async () => {
    const dirs = await makeDaemonDirs("you-brain-capture-files-pending-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeFile(join(dirs.sourceDir, "one.jsonl"), `${claudeLine("one", "a question")}\n`);

    const puts: string[] = [];
    const tracked = new Proxy(drive, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "create" || property === "update" || property === "put") {
            const first = args[0] as { path?: string } | string;
            puts.push(typeof first === "string" ? property : String(first.path ?? property));
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as MemoryDrive;

    const options = {
      clock,
      drive: tracked,
      sourceRoots: { "claude-code": [dirs.sourceDir] },
    };
    // A first run that scans but is stopped before it can upload.
    const first = await open(dirs, options);
    expect(puts.filter((path) => path.startsWith("inbox/"))).toEqual([]);
    await first.stop();
    started.splice(started.indexOf(first), 1);

    // The fingerprint exists, but no `file_id` was ever recorded: the session must be
    // queued again rather than treated as already uploaded.
    const second = await open(dirs, options);
    const uploaded = await fetch(`${second.baseUrl}/api/actions/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${second.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sources: ["claude-code"] }),
    });
    expect(uploaded.ok).toBe(true);
    expect(puts.filter((path) => path.startsWith("inbox/")).length).toBeGreaterThan(0);
  });

  it("drops a fingerprint when its file disappears", async () => {
    const dirs = await makeDaemonDirs("you-brain-capture-files-drop-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const keep = join(dirs.sourceDir, "keep.jsonl");
    const gone = join(dirs.sourceDir, "gone.jsonl");
    await writeFile(keep, `${claudeLine("keep", "keep this")}\n`);
    await writeFile(gone, `${claudeLine("gone", "remove this")}\n`);

    const options = {
      clock,
      drive,
      sourceRoots: { "claude-code": [dirs.sourceDir] },
    };
    const first = await open(dirs, options);
    await first.stop();
    started.splice(started.indexOf(first), 1);

    await rm(gone);
    const second = await open(dirs, options);
    await second.stop();
    started.splice(started.indexOf(second), 1);

    const stored = cursorValue(dirs.dataDir, "capture.files");
    const parsed = JSON.parse(stored ?? "[]") as Array<[string, unknown]>;
    expect(parsed.map(([path]) => path)).toEqual([keep]);
  });

  it("starts clean when the stored fingerprints are unreadable", async () => {
    const dirs = await makeDaemonDirs("you-brain-capture-files-bad-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeFile(join(dirs.sourceDir, "one.jsonl"), `${claudeLine("one", "a question")}\n`);
    const options = {
      clock,
      drive,
      sourceRoots: { "claude-code": [dirs.sourceDir] },
    };
    // First run creates the database; then the value is corrupted to simulate an
    // interrupted write or an older format.
    const seed = await open(dirs, options);
    await seed.stop();
    started.splice(started.indexOf(seed), 1);
    const db = new Database(join(dirs.dataDir, "state.sqlite"));
    try {
      db.run("UPDATE cursors SET value = ? WHERE key = 'capture.files'", ["not json at all"]);
    } finally {
      db.close();
    }

    const daemon = await open(dirs, options);
    // A bad value only costs one full scan; the daemon keeps running and rewrites it.
    const stored = cursorValue(dirs.dataDir, "capture.files");
    expect(stored).not.toBe("not json at all");
    expect(Array.isArray(JSON.parse(stored ?? "null"))).toBe(true);
    expect((await drive.list({ prefix: "inbox/" })).length).toBeGreaterThanOrEqual(0);
    await daemon.settled();
  });
});
