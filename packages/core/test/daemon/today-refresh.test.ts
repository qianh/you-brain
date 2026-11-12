import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import type { DriveChanges } from "../../src/drive/drive-port.js";
import {
  claudeLine,
  makeDaemonDirs,
  testClock,
  throwingEmbedder,
  writeClaudeSession,
  type DaemonDirs,
} from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Incremental change feed stays empty, so indexing the inbox cannot publish
 * "today". The only way the open page hears about the upload is the upload itself.
 */
class HiddenChangesDrive extends MemoryDrive {
  override async changes(query: { prefix: string; cursor?: string }): Promise<DriveChanges> {
    const page = await super.changes(query);
    return { ...page, entries: [], removedIds: [] };
  }
}

describe("today refresh after upload", () => {
  it("publishes today when an uploaded session lands on the current day", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("today-1", "user", "Plan the launch checklist", clock.now().toISOString()),
    ]);
    const drive = new HiddenChangesDrive({ now: () => clock.now() });
    const daemon = await startTracked(dirs, clock, drive);
    await daemon.settled();
    const kinds: string[] = [];
    const unsubscribe = daemon.changes.subscribe((event) => kinds.push(event.kind));

    await clock.advance(5 * 60_000 + INTERVALS.tickMs);
    const deadline = Date.now() + 5_000;
    let uploaded = false;
    while (Date.now() < deadline) {
      uploaded = (await drive.list({ prefix: "inbox/" })).some((file) => file.path.endsWith(".md"));
      if (uploaded) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    unsubscribe();
    expect(uploaded).toBe(true);
    const today = await fetch(`${daemon.baseUrl}/api/today`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(today.status).toBe(200);
    const body = (await today.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(1);
    expect(kinds).toContain("today");
  }, 30_000);
});

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-today-refresh-");
  roots.push(dirs.root);
  return dirs;
}

async function startTracked(
  dirs: DaemonDirs,
  clock: ReturnType<typeof testClock>,
  drive: MemoryDrive,
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "today-device",
    clock,
    drive,
    llm: null,
    embedder: throwingEmbedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  started.push(daemon);
  return daemon;
}
