import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import type { LlmBackend } from "../../src/llm/types.js";
import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import { makeDaemonDirs, testClock, type DaemonDirs } from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DAY_MS = 24 * 60 * 60 * 1000;

function webSessionMarkdown(conversationId: string, updatedAt: string): Buffer {
  return Buffer.from(
    [
      "---",
      "source: web",
      `conversation_id: ${conversationId}`,
      "device: Johns-MacBook-Pro-2.local",
      "started_at: 2026-07-18T01:00:00.000Z",
      `updated_at: ${updatedAt}`,
      "turn_count: 2",
      `content_sha256: ${"a".repeat(64)}`,
      "---",
      "",
      "## User",
      `question for ${conversationId}`,
      "",
      "## Assistant",
      "Here is the answer.",
      "",
    ].join("\n"),
  );
}

function refineAnswer(topicId: string): string {
  return JSON.stringify({
    title: "网页会话",
    summary: "从网页队列提炼出来的会话。",
    topic: { action: "create", topicId, name: `话题 ${topicId}`, aliases: [] },
    conclusions_added: [],
    todos_added: [],
    todos_completed: [],
  });
}

interface Recording {
  calls: number;
  inFlight: number;
  maxInFlight: number;
}

/** A backend that lingers long enough in each call for overlap to show. */
function recordingBackend(kind: LlmBackend["descriptor"]["kind"], record: Recording): LlmBackend {
  return {
    id: "recording",
    descriptor: {
      provider: "deepseek",
      kind,
      model: "recording",
      baseUrl: "http://127.0.0.1",
      jsonMode: "json_object",
      requiresApiKey: false,
    },
    async complete() {
      record.calls += 1;
      record.inFlight += 1;
      record.maxInFlight = Math.max(record.maxInFlight, record.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 50));
      record.inFlight -= 1;
      return refineAnswer(
        `01WEBTHROUGHPUT${record.calls.toString().padStart(16, "0")}`,
      );
    },
    test() {
      return Promise.resolve();
    },
  };
}

async function open(
  dirs: DaemonDirs,
  extra: Parameters<typeof startDaemon>[0],
): Promise<YouBrainDaemon> {
  const daemon = await startDaemon({
    homeDir: dirs.homeDir,
    platform: "darwin",
    env: dirs.env,
    hostname: "Johns-MacBook-Pro-2.local",
    clock: testClock(),
    sourceRoots: {},
    watch: false,
    signals: false,
    ...extra,
  });
  started.push(daemon);
  await daemon.settled();
  return daemon;
}

async function authHeaders(daemon: YouBrainDaemon): Promise<Record<string, string>> {
  return { authorization: `Bearer ${daemon.token}` };
}

/**
 * The device only collects the web queue once it is the main device, so the test makes
 * it one, then rewrites the files: a fresh modifiedTime re-reports them as changes and
 * the (now in-scope) pull indexes them.
 */
async function makeDeviceMainAndRequeue(
  daemon: YouBrainDaemon,
  drive: MemoryDrive,
  clock: ReturnType<typeof testClock>,
): Promise<void> {
  const headers = await authHeaders(daemon);
  const response = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
    method: "POST",
    headers,
  });
  if (!response.ok) throw new Error(await response.text());
  const status = (await fetch(`${daemon.baseUrl}/api/status`, { headers }).then((r) => r.json())) as {
    deviceId: string;
  };
  const rolesResponse = await fetch(`${daemon.baseUrl}/api/roles`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ mainDevice: status.deviceId }),
  });
  if (!rolesResponse.ok) throw new Error(await rolesResponse.text());
  await clock.advance(60_000);
  for (let index = 0; index < 3; index += 1) {
    await drive.put({
      path: `inbox/web-shared-${index}.md`,
      bytes: webSessionMarkdown(
        `web-shared-${index}`,
        new Date(clock.nowMs() - DAY_MS).toISOString(),
      ),
      mimeType: "text/markdown",
    });
  }
  const second = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
    method: "POST",
    headers,
  });
  if (!second.ok) throw new Error(await second.text());
}

describe("web session throughput", () => {
  it("refines two web sessions at once on an API backend", async () => {
    const dirs = await makeDaemonDirs("you-brain-web-parallel-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    for (let index = 0; index < 3; index += 1) {
      await drive.put({
        path: `inbox/web-shared-${index}.md`,
        bytes: webSessionMarkdown(
          `web-shared-${index}`,
          new Date(clock.nowMs() - DAY_MS).toISOString(),
        ),
        mimeType: "text/markdown",
      });
    }

    const record: Recording = { calls: 0, inFlight: 0, maxInFlight: 0 };
    const daemon = await open(dirs, {
      clock,
      drive,
      llm: recordingBackend("openai-compatible", record),
    });
    await makeDeviceMainAndRequeue(daemon, drive, clock);
    await clock.advance(INTERVALS.tickMs);
    await daemon.settled();
    await clock.advance(INTERVALS.webSessionsMs);
    await daemon.settled();

    // Three queued sessions and a two-lane worker pool: the peak only reaches two
    // when refine calls really run at the same time.
    expect(record.calls).toBe(3);
    expect(record.maxInFlight).toBe(2);
  }, 20_000);

  it("keeps the web queue sequential for a subscription CLI backend", async () => {
    const dirs = await makeDaemonDirs("you-brain-web-serial-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    for (let index = 0; index < 3; index += 1) {
      await drive.put({
        path: `inbox/web-shared-${index}.md`,
        bytes: webSessionMarkdown(
          `web-shared-${index}`,
          new Date(clock.nowMs() - DAY_MS).toISOString(),
        ),
        mimeType: "text/markdown",
      });
    }

    const record: Recording = { calls: 0, inFlight: 0, maxInFlight: 0 };
    const daemon = await open(dirs, {
      clock,
      drive,
      llm: recordingBackend("cli", record),
    });
    await makeDeviceMainAndRequeue(daemon, drive, clock);
    await clock.advance(INTERVALS.tickMs);
    await daemon.settled();
    await clock.advance(INTERVALS.webSessionsMs);
    await daemon.settled();

    // A shared CLI work directory forbids overlap, so every call ran alone.
    expect(record.calls).toBe(3);
    expect(record.maxInFlight).toBe(1);
  }, 20_000);
});
