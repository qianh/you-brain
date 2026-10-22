import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "bun:test";

import { applyCaptureRedaction } from "../../src/capture/redact.js";
import { renderSessionMarkdown } from "../../src/capture/normalize.js";
import { parseClaudeSession } from "../../src/adapters/claude.js";
import { startDaemon } from "../../src/daemon/daemon.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import type { YouBrainDaemon } from "../../src/daemon/daemon.js";
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

describe("capture retention", () => {
  it("uploads the same markdown after a scan that keeps only session metadata", async () => {
    const dirs = await trackDirs();
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const text = "Plan the launch. Authorization: Bearer cursor-secret-value";
    const path = await writeClaudeSession(dirs.sourceDir, [
      claudeLine("retain-1", "user", text, "2026-10-18T02:00:00.000Z"),
      claudeLine("retain-1", "assistant", "Use a staged rollout.", "2026-10-18T02:05:00.000Z"),
    ]);
    const daemon = await startTracked(dirs, clock, drive);
    await daemon.settled();

    const first = await dryRun(daemon);
    expect(first).toMatchObject({ dryRun: true, scanned: 1, uploaded: 0 });
    const second = await dryRun(daemon);
    expect(second.scanned).toBe(1);

    await clock.advance(5 * 60_000 + INTERVALS.outputDebounceMs);
    await daemon.settled();
    const inbox = await drive.list({ prefix: "inbox/" });
    const markdownFile = inbox.find((file) => file.path.endsWith(".md"));
    expect(markdownFile).toBeDefined();
    const uploaded = await drive.read(markdownFile!.id);

    const parsed = await parseClaudeSession(path, {
      device: "device-a",
      includeSubagents: false,
      keepToolCalls: false,
    });
    expect(parsed.session).not.toBeNull();
    const once = applyCaptureRedaction(parsed.session!, {
      redact: true,
      redaction: {},
    });
    const twice = applyCaptureRedaction(once.session, { redact: true, redaction: {} });
    const expected = renderSessionMarkdown(twice.session, {
      redactionVersion: twice.version,
      redactionCount: twice.count,
      imageReferences: new Map(),
    });
    expect(uploaded.bytes.toString("utf8")).toBe(expected.markdown);
    expect(expected.markdown).toContain("Authorization: Bearer [REDACTED]");
    expect(expected.markdown).toContain("Use a staged rollout.");
  });
});

async function dryRun(daemon: YouBrainDaemon): Promise<{ scanned: number; uploaded: number; dryRun: boolean }> {
  const response = await fetch(`${daemon.baseUrl}/api/actions/upload`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ dryRun: true }),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as { scanned: number; uploaded: number; dryRun: boolean };
}

async function trackDirs(): Promise<DaemonDirs> {
  const dirs = await makeDaemonDirs("you-brain-capture-retain-");
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
  return daemon;
}
