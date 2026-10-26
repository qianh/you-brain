import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { SearchService } from "../../src/search/index.js";
import { makeDaemonDirs, testClock, type DaemonDirs } from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function inboxFile(id: string): Buffer {
  return Buffer.from(
    [
      "---",
      "source: claude-code",
      `conversation_id: ${id}`,
      "device: device-a",
      "started_at: 2026-10-17T01:00:00.000Z",
      "updated_at: 2026-10-17T02:00:00.000Z",
      "turn_count: 2",
      "---",
      "",
      "hello",
      "",
    ].join("\n"),
  );
}

/** Lets the manual clock fire the tick armed by the previous one. */
async function tick(clock: ReturnType<typeof testClock>, daemon: YouBrainDaemon): Promise<void> {
  await clock.advance(1_000);
  await daemon.settled();
}

describe("search scheduling", () => {
  it("keeps vector backfill on its own clock instead of re-syncing text every tick", async () => {
    const dirs: DaemonDirs = await makeDaemonDirs("you-brain-search-schedule-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await drive.put({
      path: "inbox/device-a/claude-code/2026/10/one.md",
      bytes: inboxFile("one"),
      mimeType: "text/markdown",
    });
    const daemon = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "device-a",
      clock,
      drive,
      llm: null,
      sourceRoots: {},
      watch: false,
      signals: false,
    });
    started.push(daemon);
    await daemon.settled();

    // A model that never finishes the index: each pass fills one batch and leaves holes,
    // which is what a CPU-bound embedder does on a real library.
    let backfills = 0;
    const backfill = spyOn(SearchService.prototype, "backfillVectors").mockImplementation(() => {
      backfills += 1;
      return Promise.resolve({ embedded: 8, remaining: 999, warnings: [] });
    });
    const sync = spyOn(SearchService.prototype, "sync");
    try {
      // The first text pass runs on the search interval, then hands over to the backfill.
      await clock.advance(60_000);
      await daemon.settled();
      expect(backfills).toBeGreaterThan(0);

      // Text sync is up to date, so the next ticks belong to the backfill alone.
      const syncsBefore = sync.mock.calls.length;
      backfills = 0;
      for (let index = 0; index < 10; index += 1) await tick(clock, daemon);

      // One embed batch per tick is expected. One change-feed pull per tick is not.
      expect(backfills).toBeGreaterThanOrEqual(10);
      expect(sync.mock.calls.length - syncsBefore).toBe(0);
    } finally {
      backfill.mockRestore();
      sync.mockRestore();
    }
  });
});
