import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import type { DaemonClock } from "../../src/daemon/clock.js";
import type { DrivePort } from "../../src/drive/drive-port.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
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

describe("upload budget", () => {
  it("ends an upload pass once its time is spent", async () => {
    const dirs: DaemonDirs = await makeDaemonDirs("you-brain-upload-budget-");
    roots.push(dirs.root);
    const manual = testClock();
    // Uploads take wall time that the manual clock only sees when told.
    let elapsed = 0;
    const clock: DaemonClock = {
      now: () => new Date(manual.nowMs() + elapsed),
      nowMs: () => manual.nowMs() + elapsed,
      schedule: (ms, fn) => manual.schedule(ms, fn),
    };
    const memory = new MemoryDrive({ now: () => clock.now() });
    const uploadTicks: number[] = [];
    const drive = new Proxy(memory, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "put" || property === "create") {
            const path = String((args[0] as { path: string }).path);
            if (path.startsWith("inbox/")) uploadTicks.push(manual.nowMs());
            if (path.startsWith("inbox/")) elapsed += 21_000;
          }
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DrivePort;
    for (const id of ["a", "b", "c"]) {
      await writeClaudeSession(
        dirs.sourceDir,
        [claudeLine(`budget-${id}`, "user", `Plan the launch ${id}`, "2026-10-18T02:00:00.000Z")],
        `${id}.jsonl`,
      );
    }
    const daemon = await startDaemon({
      homeDir: dirs.homeDir,
      platform: "darwin",
      env: dirs.env,
      hostname: "device-a",
      clock,
      drive,
      llm: null,
      embedder: throwingEmbedder,
      sourceRoots: { "claude-code": [dirs.sourceDir] },
      watch: false,
      signals: false,
    });
    started.push(daemon);
    await daemon.settled();
    // A backfill makes every session due at once.
    await fetch(`${daemon.baseUrl}/api/actions/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      body: JSON.stringify({ backfill: true, dryRun: true }),
    });
    await manual.advance(10_000);
    await daemon.settled();

    expect(uploadTicks).toHaveLength(3);
    // The budget ends a pass after one slow upload, so each pass is a separate tick.
    expect(new Set(uploadTicks).size).toBe(3);
  });
});
