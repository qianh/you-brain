import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { discoverSessions } from "../../src/adapters/index.js";
import {
  parseZcodePath,
  parseZcodeSession,
  zcodeSourcePath,
} from "../../src/adapters/zcode.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface PartSeed {
  type: string;
  text?: string;
  tool?: string;
  input?: unknown;
}

interface MessageSeed {
  role: "user" | "assistant";
  /** ZCode marks injected context as `agent_runtime`; only `real_user` is the user's own words. */
  origin?: string;
  visibility?: string;
  at: string;
  parts: PartSeed[];
}

interface SessionSeed {
  id: string;
  parentId?: string | null;
  directory?: string;
  deletedAt?: string | null;
  messages: MessageSeed[];
}

/** Builds a database with the columns the adapter reads, in the order ZCode declares them. */
async function makeDatabase(sessions: SessionSeed[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "you-brain-zcode-"));
  roots.push(root);
  await mkdir(join(root, "db"), { recursive: true });
  const path = join(root, "db", "db.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      parent_id TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_deleted INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      sequence INTEGER
    );
  `);
  const insertSession = db.prepare(
    `INSERT INTO session(id, project_id, slug, directory, title, version, parent_id,
       time_created, time_updated, time_deleted)
     VALUES (?, 'project-1', 'a-session', ?, 'A session', '1.0.0', ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO message(id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertPart = db.prepare(
    `INSERT INTO part(id, message_id, session_id, time_created, time_updated, data, sequence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const session of sessions) {
    const first = session.messages[0]?.at ?? "2026-10-17T01:00:00.000Z";
    const last = session.messages.at(-1)?.at ?? first;
    insertSession.run(
      session.id,
      session.directory ?? "/Users/tester/project",
      session.parentId ?? null,
      Date.parse(first),
      Date.parse(last),
      session.deletedAt ? Date.parse(session.deletedAt) : null,
    );
    for (const [index, message] of session.messages.entries()) {
      const at = Date.parse(message.at);
      const messageId = `${session.id}-m${index}`;
      insertMessage.run(
        messageId,
        session.id,
        at,
        at,
        JSON.stringify({
          role: message.role,
          time: { created: at },
          semantics: {
            origin: message.origin ?? (message.role === "user" ? "real_user" : "agent_runtime"),
            ...(message.visibility ? { transcriptVisibility: message.visibility } : {}),
          },
          ...(message.visibility === "model-only"
            ? { metadata: { visibility: "model-only" } }
            : {}),
        }),
        index,
      );
      for (const [partIndex, part] of message.parts.entries()) {
        insertPart.run(
          `${messageId}-p${partIndex}`,
          messageId,
          session.id,
          at,
          at,
          JSON.stringify(
            part.type === "tool"
              ? { type: "tool", tool: part.tool, state: { input: part.input } }
              : { type: part.type, text: part.text },
          ),
          partIndex,
        );
      }
    }
  }
  db.close();
  return path;
}

describe("zcode adapter", () => {
  it("reads real user prompts and assistant text, dropping reasoning and injected context", async () => {
    const database = await makeDatabase([
      {
        id: "session-1",
        messages: [
          {
            role: "user",
            at: "2026-10-17T01:00:00.000Z",
            parts: [{ type: "text", text: "review the config" }],
          },
          {
            role: "user",
            origin: "agent_runtime",
            visibility: "model-only",
            at: "2026-10-17T01:00:01.000Z",
            parts: [{ type: "text", text: "<environment_context>cwd</environment_context>" }],
          },
          {
            role: "assistant",
            at: "2026-10-17T01:00:02.000Z",
            parts: [
              { type: "reasoning", text: "private thought" },
              { type: "text", text: "Looking at it." },
              { type: "tool", tool: "Bash", input: { command: "cat config.json" } },
            ],
          },
        ],
      },
    ]);

    const result = await parseZcodeSession(zcodeSourcePath(database, "session-1"), {
      device: "test-device",
      includeSubagents: false,
    });

    expect(result.session?.source).toBe("zcode");
    expect(result.session?.conversationId).toBe("session-1");
    expect(result.session?.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "review the config"],
      ["assistant", "Looking at it."],
    ]);
    expect(result.session?.startedAt).toBe("2026-10-17T01:00:00.000Z");
    expect(result.session?.updatedAt).toBe("2026-10-17T01:00:02.000Z");
    const serialized = JSON.stringify(result.session);
    expect(serialized).not.toContain("private thought");
    expect(serialized).not.toContain("environment_context");
  });

  it("keeps tool calls as text when asked", async () => {
    const database = await makeDatabase([
      {
        id: "session-tools",
        messages: [
          {
            role: "user",
            at: "2026-10-17T01:00:00.000Z",
            parts: [{ type: "text", text: "list the repo" }],
          },
          {
            role: "assistant",
            at: "2026-10-17T01:00:01.000Z",
            parts: [{ type: "tool", tool: "Bash", input: { command: "ls" } }],
          },
        ],
      },
    ]);

    const result = await parseZcodeSession(zcodeSourcePath(database, "session-tools"), {
      device: "test-device",
      includeSubagents: false,
      keepToolCalls: true,
      toolCallMaxChars: 200,
    });

    expect(result.session?.turns.map((turn) => turn.text)).toEqual([
      "list the repo",
      '[tool] Bash {"command":"ls"}',
    ]);
  });

  it("skips subagent sessions unless they are included", async () => {
    const database = await makeDatabase([
      {
        id: "session-child",
        parentId: "session-parent",
        messages: [
          {
            role: "user",
            at: "2026-10-17T01:00:00.000Z",
            parts: [{ type: "text", text: "subagent task" }],
          },
        ],
      },
    ]);

    const skipped = await parseZcodeSession(zcodeSourcePath(database, "session-child"), {
      device: "test-device",
      includeSubagents: false,
    });
    expect(skipped.session).toBeNull();
    expect(skipped.skippedSubagent).toBe(true);

    const kept = await parseZcodeSession(zcodeSourcePath(database, "session-child"), {
      device: "test-device",
      includeSubagents: true,
    });
    expect(kept.session?.turns[0]?.text).toBe("subagent task");
  });

  it("skips the dedicated subscription CLI workdir", async () => {
    const database = await makeDatabase([
      {
        id: "session-cli",
        directory: "/tmp/llm-cli",
        messages: [
          {
            role: "user",
            at: "2026-10-17T01:00:00.000Z",
            parts: [{ type: "text", text: "internal prompt" }],
          },
        ],
      },
    ]);

    const result = await parseZcodeSession(zcodeSourcePath(database, "session-cli"), {
      device: "test-device",
      includeSubagents: false,
      llmCliWorkDir: "/tmp/llm-cli",
    });
    expect(result.session).toBeNull();
  });

  it("ignores deleted sessions and sessions without conversation text", async () => {
    const database = await makeDatabase([
      {
        id: "deleted",
        deletedAt: "2026-10-18T00:00:00.000Z",
        messages: [
          {
            role: "user",
            at: "2026-10-17T01:00:00.000Z",
            parts: [{ type: "text", text: "gone" }],
          },
        ],
      },
      {
        id: "reasoning-only",
        messages: [
          {
            role: "assistant",
            at: "2026-10-17T01:00:00.000Z",
            parts: [{ type: "reasoning", text: "thinking" }],
          },
        ],
      },
    ]);

    expect(
      (await parseZcodeSession(zcodeSourcePath(database, "deleted"), {
        device: "test-device",
        includeSubagents: false,
      })).session,
    ).toBeNull();
    const reasoningOnly = await parseZcodeSession(
      zcodeSourcePath(database, "reasoning-only"),
      { device: "test-device", includeSubagents: false },
    );
    expect(reasoningOnly.session).toBeNull();
    expect(reasoningOnly.skippedNoise).toBe(true);
  });

  it("discovers live sessions in the database", async () => {
    const database = await makeDatabase([
      {
        id: "session-native",
        messages: [
          {
            role: "user",
            at: "2026-10-17T02:00:00.000Z",
            parts: [{ type: "text", text: "native" }],
          },
          {
            role: "assistant",
            at: "2026-10-17T02:00:01.000Z",
            parts: [{ type: "text", text: "reply" }],
          },
        ],
      },
      {
        id: "session-deleted",
        deletedAt: "2026-10-18T00:00:00.000Z",
        messages: [
          {
            role: "user",
            at: "2026-10-17T01:00:00.000Z",
            parts: [{ type: "text", text: "gone" }],
          },
        ],
      },
    ]);

    const discovered = await discoverSessions({
      device: "test-device",
      includeSubagents: false,
      sources: ["zcode"],
      paths: {
        claude: [],
        codex: [],
        grok: [],
        cursor: [],
        zcode: [join(database, "..")],
      },
    });

    expect(discovered.status.zcode).toMatchObject({ discovered: 1, captured: 1 });
    expect(discovered.sessions.map((session) => session.conversationId)).toEqual([
      "session-native",
    ]);
  });

  it("rejects a path without a session id and reads the id back", () => {
    expect(parseZcodePath("/tmp/db.sqlite")).toBeNull();
    expect(parseZcodePath("/tmp/db.sqlite#")).toBeNull();
    expect(parseZcodePath("/tmp/db.sqlite#session-1")).toEqual({
      database: "/tmp/db.sqlite",
      sessionId: "session-1",
    });
    expect(zcodeSourcePath("/tmp/db.sqlite", "session-1")).toBe(
      "/tmp/db.sqlite#session-1",
    );
  });
});
