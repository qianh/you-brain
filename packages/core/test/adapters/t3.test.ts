import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { discoverSessions } from "../../src/adapters/index.js";
import {
  isImportedThread,
  parseT3Path,
  parseT3Session,
  t3SourcePath,
} from "../../src/adapters/t3.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ThreadSeed {
  threadId: string;
  title?: string;
  worktreePath?: string | null;
  deletedAt?: string | null;
  messages: Array<{ role: string; text: string; at: string }>;
}

/** Builds a database with the columns the adapter reads, in the order T3 declares them. */
async function makeDatabase(threads: ThreadSeed[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-t3-"));
  roots.push(root);
  await mkdir(join(root, "userdata"), { recursive: true });
  const path = join(root, "userdata", "state.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      worktree_path TEXT
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const insertThread = db.prepare(
    `INSERT INTO projection_threads(thread_id, title, created_at, updated_at, deleted_at, worktree_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO projection_thread_messages(message_id, thread_id, role, text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const thread of threads) {
    const first = thread.messages[0]?.at ?? "2026-10-17T01:00:00.000Z";
    const last = thread.messages.at(-1)?.at ?? first;
    insertThread.run(
      thread.threadId,
      thread.title ?? "A thread",
      first,
      last,
      thread.deletedAt ?? null,
      thread.worktreePath === undefined ? "/Users/tester/project" : thread.worktreePath,
    );
    for (const [index, message] of thread.messages.entries()) {
      insertMessage.run(
        `${thread.threadId}-m${index}`,
        thread.threadId,
        message.role,
        message.text,
        message.at,
      );
    }
  }
  db.close();
  return path;
}

describe("t3 adapter", () => {
  it("reads user and assistant messages and drops reasoning rows", async () => {
    const database = await makeDatabase([
      {
        threadId: "thread-1",
        title: "Review the config",
        messages: [
          { role: "user", text: "review the config", at: "2026-10-17T01:00:00.000Z" },
          { role: "reasoning", text: "private thought", at: "2026-10-17T01:00:01.000Z" },
          { role: "assistant", text: "Looks fine.", at: "2026-10-17T01:00:02.000Z" },
        ],
      },
    ]);

    const result = await parseT3Session(t3SourcePath(database, "thread-1"), {
      device: "test-device",
      includeSubagents: false,
    });

    expect(result.session?.source).toBe("t3-code");
    expect(result.session?.conversationId).toBe("thread-1");
    expect(result.session?.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "review the config"],
      ["assistant", "Looks fine."],
    ]);
    expect(result.session?.startedAt).toBe("2026-10-17T01:00:00.000Z");
    expect(result.session?.updatedAt).toBe("2026-10-17T01:00:02.000Z");
    expect(JSON.stringify(result.session)).not.toContain("private thought");
  });

  it("skips threads that T3 imported from another tool", async () => {
    const database = await makeDatabase([
      {
        threadId: "import:claudeAgent:abc",
        messages: [{ role: "user", text: "imported", at: "2026-10-17T01:00:00.000Z" }],
      },
      {
        threadId: "thread-native",
        messages: [
          { role: "user", text: "native", at: "2026-10-17T02:00:00.000Z" },
          { role: "assistant", text: "reply", at: "2026-10-17T02:00:01.000Z" },
        ],
      },
    ]);

    const imported = await parseT3Session(
      t3SourcePath(database, "import:claudeAgent:abc"),
      { device: "test-device", includeSubagents: false },
    );
    expect(imported.session).toBeNull();

    const discovered = await discoverSessions({
      device: "test-device",
      includeSubagents: false,
      sources: ["t3-code"],
      paths: { claude: [], codex: [], grok: [], cursor: [], t3: [join(database, "..")] },
    });
    expect(discovered.status.t3).toMatchObject({ discovered: 1, captured: 1 });
    expect(discovered.sessions.map((session) => session.conversationId)).toEqual([
      "thread-native",
    ]);
  });

  it("ignores deleted threads and threads without conversation text", async () => {
    const database = await makeDatabase([
      {
        threadId: "deleted",
        deletedAt: "2026-10-18T00:00:00.000Z",
        messages: [{ role: "user", text: "gone", at: "2026-10-17T01:00:00.000Z" }],
      },
      {
        threadId: "reasoning-only",
        messages: [
          { role: "reasoning", text: "thinking", at: "2026-10-17T01:00:00.000Z" },
        ],
      },
    ]);

    expect(
      (await parseT3Session(t3SourcePath(database, "deleted"), {
        device: "test-device",
        includeSubagents: false,
      })).session,
    ).toBeNull();
    expect(
      (await parseT3Session(t3SourcePath(database, "reasoning-only"), {
        device: "test-device",
        includeSubagents: false,
      })).session,
    ).toBeNull();
  });

  it("rejects a path without a thread id and reads the id back", () => {
    expect(parseT3Path("/tmp/state.sqlite")).toBeNull();
    expect(parseT3Path("/tmp/state.sqlite#")).toBeNull();
    expect(parseT3Path("/tmp/state.sqlite#thread-1")).toEqual({
      database: "/tmp/state.sqlite",
      threadId: "thread-1",
    });
    expect(isImportedThread("import:codex:1")).toBe(true);
    expect(isImportedThread("thread-1")).toBe(false);
  });
});
