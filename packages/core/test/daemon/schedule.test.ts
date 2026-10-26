import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS, intervalDue, pullInterval } from "../../src/daemon/schedule.js";
import type { YouBrainDaemon } from "../../src/daemon/daemon.js";
import {
  claudeLine,
  fakeBackend,
  makeDaemonDirs,
  refineNow,
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

describe("schedule intervals", () => {
  it("treats a missing cursor as due and speeds up while subscribers exist", () => {
    expect(intervalDue(null, 1_000, INTERVALS.pullMs)).toBe(true);
    expect(intervalDue(0, INTERVALS.flushMs - 1, INTERVALS.flushMs)).toBe(false);
    expect(intervalDue(0, INTERVALS.flushMs, INTERVALS.flushMs)).toBe(true);
    expect(pullInterval(0)).toBe(INTERVALS.pullMs);
    expect(pullInterval(1)).toBe(INTERVALS.fastPullMs);
    expect(INTERVALS.reminderMs).toBe(10 * 60_000);
    expect(intervalDue(null, 0, INTERVALS.reminderMs)).toBe(true);
    expect(intervalDue(0, INTERVALS.reminderMs - 1, INTERVALS.reminderMs)).toBe(false);
  });

  it("uploads an idle session at 5 minutes and not at 4", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("idle-1", "user", "Plan the launch checklist", "2026-10-18T02:00:00.000Z"),
    ]);
    const daemon = await startTracked(dirs, clock, drive, null);
    await daemon.settled();
    await clock.advance(4 * 60_000);
    await daemon.settled();
    expect(await drive.list({ prefix: "inbox/" })).toHaveLength(0);

    await clock.advance(60_000);
    await daemon.settled();
    const inbox = await drive.list({ prefix: "inbox/" });
    expect(inbox.some((file) => file.path.endsWith(".md"))).toBe(true);
  });

  it("uploads a still-active session at 5 minutes and refines after it later goes idle", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    let refined = 0;
    const llm = fakeBackend(async (request) => {
      refined += 1;
      const summary = request.user.includes("rollback") ? "补充了回滚步骤" : "讨论了分阶段发布";
      return JSON.stringify({
        title: "发布清单",
        summary,
        topic: { action: "create", topicId: "", name: "发布流程", aliases: [] },
        conclusions_added: [],
        todos_added: [],
        todos_completed: [],
      });
    });
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("active-1", "user", "Plan the launch checklist", "2026-10-18T02:00:00.000Z"),
    ]);
    const daemon = await startTracked(dirs, clock, drive, llm);
    await daemon.settled();

    await clock.advance(4 * 60_000);
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("active-1", "user", "Plan the launch checklist again", "2026-10-18T02:04:00.000Z"),
    ]);
    await daemon.scan();
    await daemon.settled();
    expect(refined).toBe(0);
    expect(await drive.list({ prefix: "inbox/" })).toHaveLength(0);

    await clock.advance(60_000);
    await daemon.settled();
    expect(await drive.list({ prefix: "inbox/" })).not.toHaveLength(0);

    // The session only reaches the model through the refine pass, not through the upload.
    await refineNow(clock, daemon);
    expect(refined).toBe(1);

    // Editing the file without adding a turn leaves nothing new to refine, so the model
    // is not asked again even though the bytes changed.
    await writeClaudeSession(dirs.sourceDir, [
      claudeLine("active-1", "user", "Add a rollback step", "2026-10-18T02:05:00.000Z"),
    ]);
    await daemon.scan();
    await clock.advance(5 * 60_000 + INTERVALS.outputDebounceMs);
    await daemon.settled();
    await refineNow(clock, daemon);
    expect(refined).toBe(1);
  });
});

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-schedule-");
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
