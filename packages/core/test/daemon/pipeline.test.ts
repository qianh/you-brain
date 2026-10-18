import { readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import type { YouBrainDaemon } from "../../src/daemon/daemon.js";
import {
  claudeLine,
  fakeBackend,
  makeDaemonDirs,
  readStatus,
  refineJson,
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

describe("daemon pipeline", () => {
  it("retries a failed refine on the next attempt", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    let calls = 0;
    const llm = fakeBackend(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return refineJson("讨论了分阶段发布");
    });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("retry-1", "user", "Plan the launch checklist", "2026-10-18T02:00:00.000Z"),
    ]);
    const daemon = await startTracked(dirs, clock, drive, llm);
    await daemon.settled();
    await clock.advance(5 * 60_000);
    await daemon.settled();
    const failed = await readStatus(daemon);
    expect(failed.refine.pending).toBe(1);
    expect(failed.refine.lastError).toContain("boom");

    await clock.advance(1_000);
    await daemon.settled();
    const recovered = await readStatus(daemon);
    expect(recovered.refine.pending).toBe(0);
    expect(calls).toBe(2);
  });

  it("full-scans after 10 minutes without an explicit scan, then uploads once idle", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const daemon = await startTracked(dirs, clock, drive, null);
    await daemon.settled();
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("scan-1", "user", "Plan the launch checklist", "2026-10-18T02:00:00.000Z"),
    ]);
    await clock.advance(INTERVALS.fullScanMs);
    await daemon.settled();
    expect(await drive.list({ prefix: "inbox/" })).toHaveLength(0);

    await clock.advance(5 * 60_000);
    await daemon.settled();
    expect((await drive.list({ prefix: "inbox/" })).some((file) => file.path.endsWith(".md"))).toBe(
      true,
    );
    const today = await readFile(joinToday(dirs.homeDir), "utf8").catch(() => "");
    expect(today.length).toBeGreaterThanOrEqual(0);
  });
});

function joinToday(homeDir: string): string {
  return `${homeDir}/TODAY.md`;
}

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-pipeline-");
  roots.push(dirs.root);
  return dirs;
}

async function startTracked(
  dirs: DaemonDirs,
  clock: ReturnType<typeof testClock>,
  drive: MemoryDrive,
  llm: ReturnType<typeof fakeBackend> | null,
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "device-a",
    clock,
    drive,
    llm,
    embedder: throwingEmbedder,
    sourceRoots: { "claude-code": [dirs.sourceDir] },
    watch: false,
    signals: false,
  });
  started.push(daemon);
  return daemon;
}
