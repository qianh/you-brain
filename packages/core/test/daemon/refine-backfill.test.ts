import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { startDaemon, type YouBrainDaemon } from "../../src/daemon/daemon.js";
import { conversationKey } from "../../src/domain/session.js";
import { MemoryDrive } from "../../src/drive/memory-drive.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { INTERVALS } from "../../src/daemon/schedule.js";
import {
  fakeBackend,
  makeDaemonDirs,
  readStatus,
  testClock,
  type DaemonDirs,
} from "./helpers.js";

const started: YouBrainDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** The markdown the upload step writes: frontmatter plus `## User` / `## Assistant`. */
function sessionMarkdown(input: {
  conversationId: string;
  updatedAt: string;
  text: string;
}): Buffer {
  return Buffer.from(
    [
      "---",
      "source: codex",
      `conversation_id: ${input.conversationId}`,
      "device: Johns-MacBook-Pro-2.local",
      "started_at: 2026-07-18T01:00:00.000Z",
      `updated_at: ${input.updatedAt}`,
      "turn_count: 2",
      `content_sha256: ${"a".repeat(64)}`,
      "---",
      "",
      "## User",
      input.text,
      "",
      "## Assistant",
      "Here is the answer.",
      "",
    ].join("\n"),
  );
}

/** A refine answer that assigns every session to one existing-or-new topic. */
function refineAnswer(input: { topicId: string; name: string }): string {
  return JSON.stringify({
    title: "回灌会话",
    summary: "从历史回灌提炼出来的会话。",
    topic: { action: "create", topicId: input.topicId, name: input.name, aliases: [] },
    conclusions_added: [],
    todos_added: [],
    todos_completed: [],
  });
}

/** Pull and index the inbox so the sessions exist in the store before the backfill runs. */
async function sync(daemon: YouBrainDaemon): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/actions/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  if (!response.ok) throw new Error(await response.text());
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

describe("refine backfill", () => {
  it("refines an uploaded session that was never refined, newest first", async () => {
    const dirs = await makeDaemonDirs("you-brain-refine-backfill-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const now = clock.nowMs();
    const newer = await drive.put({
      path: "inbox/Johns-MacBook-Pro-2.local/codex/newer.md",
      bytes: sessionMarkdown({
        conversationId: "newer",
        updatedAt: new Date(now - 2 * DAY_MS).toISOString(),
        text: "newer question",
      }),
      mimeType: "text/markdown",
    });
    const older = await drive.put({
      path: "inbox/Johns-MacBook-Pro-2.local/codex/older.md",
      bytes: sessionMarkdown({
        conversationId: "older",
        updatedAt: new Date(now - 5 * DAY_MS).toISOString(),
        text: "older question",
      }),
      mimeType: "text/markdown",
    });

    const prompts: string[] = [];
    const llm = fakeBackend((request) => {
      prompts.push(request.user);
      return Promise.resolve(refineAnswer({ topicId: "01TOPICBACKFILL0000000000", name: "回灌话题" }));
    });
    const daemon = await open(dirs, { clock, drive, llm });
    await sync(daemon);
    await clock.advance(INTERVALS.tickMs);
    await daemon.settled();

    // The inbox is indexed by the pull; the backfill then reads the markdown back.
    await clock.advance(INTERVALS.refineBackfillMs);
    await daemon.settled();

    expect(prompts.length).toBeGreaterThan(0);
    // The newest session is offered to the model first.
    expect(prompts[0]).toContain("newer question");
    expect(prompts[0]).not.toContain("older question");
    expect(newer.id).not.toBe(older.id);
  });

  it("leaves sessions outside the 30-day window unrefined", async () => {
    const dirs = await makeDaemonDirs("you-brain-refine-window-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const now = clock.nowMs();
    await drive.put({
      path: "inbox/Johns-MacBook-Pro-2.local/codex/recent.md",
      bytes: sessionMarkdown({
        conversationId: "recent",
        updatedAt: new Date(now - 3 * DAY_MS).toISOString(),
        text: "recent question",
      }),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "inbox/Johns-MacBook-Pro-2.local/codex/ancient.md",
      bytes: sessionMarkdown({
        conversationId: "ancient",
        updatedAt: new Date(now - 200 * DAY_MS).toISOString(),
        text: "ancient question",
      }),
      mimeType: "text/markdown",
    });

    const prompts: string[] = [];
    const llm = fakeBackend((request) => {
      prompts.push(request.user);
      return Promise.resolve(refineAnswer({ topicId: "01TOPICWINDOW00000000000", name: "窗口话题" }));
    });
    const daemon = await open(dirs, { clock, drive, llm });
    await sync(daemon);
    await clock.advance(INTERVALS.tickMs);
    await daemon.settled();

    await clock.advance(INTERVALS.refineBackfillMs);
    await daemon.settled();

    expect(prompts.join("\n")).toContain("recent question");
    expect(prompts.join("\n")).not.toContain("ancient question");
  });

  it("does not refine another device's sessions", async () => {
    const dirs = await makeDaemonDirs("you-brain-refine-device-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const now = clock.nowMs();
    // This device's own session, so the backfill has something to do and the store is
    // open. The other device's row is inserted directly: its files are not downloaded
    // here (the search scope keeps them out), which is exactly why the backfill must
    // not pick it up from the sessions table.
    await drive.put({
      path: "inbox/Johns-MacBook-Pro-2.local/codex/mine.md",
      bytes: sessionMarkdown({
        conversationId: "mine",
        updatedAt: new Date(now - 2 * DAY_MS).toISOString(),
        text: "my own question",
      }),
      mimeType: "text/markdown",
    });

    const prompts: string[] = [];
    const reads: string[] = [];
    const llm = fakeBackend((request) => {
      prompts.push(request.user);
      return Promise.resolve(refineAnswer({ topicId: "01TOPICDEVICE00000000000", name: "别的设备" }));
    });
    const tracked = new Proxy(drive, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "read") reads.push(String(args[0]));
          return (value as (...input: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as MemoryDrive;
    const daemon = await open(dirs, { clock, drive: tracked, llm });
    await sync(daemon);
    await clock.advance(INTERVALS.tickMs);
    await daemon.settled();

    const store = new SqliteStore(join(dirs.dataDir, "state.sqlite"));
    try {
      store.upsertSession({
        sessionKey: conversationKey("codex", "elsewhere"),
        source: "codex",
        device: "other-mac",
        startedAt: new Date(now - 2 * DAY_MS).toISOString(),
        updatedAt: new Date(now - 2 * DAY_MS).toISOString(),
        fileId: "file-elsewhere",
        msgCount: 2,
        refinedUpTo: 0,
      });
    } finally {
      store.close();
    }

    await clock.advance(INTERVALS.refineBackfillMs);
    await daemon.settled();

    expect(prompts.join("\n")).toContain("my own question");
    expect(prompts.join("\n")).not.toContain("elsewhere");
    // Not even an attempted download: the row is filtered out before Drive is touched.
    expect(reads).not.toContain("file-elsewhere");
  });

  it("refines a session that arrived after startup, because upload no longer refines", async () => {
    const dirs = await makeDaemonDirs("you-brain-refine-live-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    const prompts: string[] = [];
    const llm = fakeBackend((request) => {
      prompts.push(request.user);
      return Promise.resolve(refineAnswer({ topicId: "01TOPICLIVE000000000000", name: "活跃会话" }));
    });
    // No local source roots: the session only reaches the store through the inbox.
    const daemon = await open(dirs, { clock, drive, llm });
    await drive.put({
      path: "inbox/Johns-MacBook-Pro-2.local/codex/live.md",
      bytes: sessionMarkdown({
        conversationId: "live",
        updatedAt: new Date(clock.nowMs()).toISOString(),
        text: "a live question",
      }),
      mimeType: "text/markdown",
    });
    await sync(daemon);
    await clock.advance(INTERVALS.tickMs);
    await daemon.settled();

    // A session that arrived after startup is refined here too: this pass is the only
    // place a captured session reaches the model now.
    await clock.advance(INTERVALS.refineBackfillMs);
    await daemon.settled();
    expect(prompts.join("\n")).toContain("a live question");
  });

  it("reports no refine error when the backfill is not configured", async () => {
    const dirs = await makeDaemonDirs("you-brain-refine-nollm-");
    roots.push(dirs.root);
    const clock = testClock();
    const drive = new MemoryDrive({ now: () => clock.now() });
    await drive.put({
      path: "inbox/Johns-MacBook-Pro-2.local/codex/one.md",
      bytes: sessionMarkdown({
        conversationId: "one",
        updatedAt: new Date(clock.nowMs() - DAY_MS).toISOString(),
        text: "a question",
      }),
      mimeType: "text/markdown",
    });
    const daemon = await open(dirs, { clock, drive, llm: null });

    await clock.advance(INTERVALS.refineBackfillMs);
    await daemon.settled();

    const status = await readStatus(daemon);
    expect(status.refine.lastError).toBeNull();
  });
});
