import { cp, mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "bun:test";

import { discoverSessions } from "../../src/adapters/index.js";

const fixtures = resolve(import.meta.dirname, "..", "fixtures");

describe("session discovery", () => {
  it("discovers all configured sources and aggregates skips/malformed lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "brainhub-discovery-"));
    const claude = join(root, "claude", "project", "session.jsonl");
    const codex = join(root, "codex", "2026", "07", "18", "rollout-test.jsonl");
    const grok = join(root, "grok", "workspace", "top-level");
    const cursor = join(
      root,
      "cursor",
      "workspace",
      "agent-transcripts",
      "cursor-1",
      "cursor-1.jsonl",
    );
    const nestedCursor = join(dirname(cursor), "nested", "nested.jsonl");
    await Promise.all([
      mkdir(dirname(claude), { recursive: true }),
      mkdir(dirname(codex), { recursive: true }),
      mkdir(grok, { recursive: true }),
      mkdir(dirname(nestedCursor), { recursive: true }),
    ]);
    await cp(join(fixtures, "claude", "top-level.jsonl"), claude);
    await cp(join(fixtures, "codex", "top-level.jsonl"), codex);
    await cp(
      join(fixtures, "grok", "top-level", "summary.json"),
      join(grok, "summary.json"),
    );
    await cp(
      join(fixtures, "grok", "top-level", "chat_history.jsonl"),
      join(grok, "chat_history.jsonl"),
    );
    await Promise.all([
      cp(join(fixtures, "cursor", "top-level.jsonl"), cursor),
      cp(join(fixtures, "cursor", "top-level.jsonl"), nestedCursor),
    ]);
    const grokShell = join(root, "grok", "workspace", "summary-only");
    await mkdir(grokShell, { recursive: true });
    await cp(
      join(fixtures, "grok", "top-level", "summary.json"),
      join(grokShell, "summary.json"),
    );

    const result = await discoverSessions({
      device: "test",
      includeSubagents: false,
      sources: ["claude-code", "codex", "grok-build", "cursor"],
      paths: {
        claude: [join(root, "claude")],
        codex: [join(root, "codex")],
        grok: [join(root, "grok")],
        cursor: [join(root, "cursor")],
      },
    });

    expect(result.sessions.map((session) => session.source).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "grok-build",
    ]);
    expect(result.malformed).toBe(2);
    expect(result.status.codex.discovered).toBe(1);
    expect(result.status.cursor).toMatchObject({ discovered: 1, captured: 1 });
    expect(result.status.grok.discovered).toBe(1);
    expect(result.status.grok.errors).toBe(0);
  });

  it("parses only files newer than the incremental watermark", async () => {
    const root = await mkdtemp(join(tmpdir(), "brainhub-incremental-"));
    const oldPath = join(root, "2026", "07", "17", "rollout-old.jsonl");
    const newPath = join(root, "2026", "07", "19", "rollout-new.jsonl");
    await Promise.all([
      mkdir(dirname(oldPath), { recursive: true }),
      mkdir(dirname(newPath), { recursive: true }),
    ]);
    await Promise.all([
      cp(join(fixtures, "codex", "top-level.jsonl"), oldPath),
      cp(join(fixtures, "codex", "top-level.jsonl"), newPath),
    ]);
    await Promise.all([
      utimes(
        oldPath,
        new Date("2026-07-17T00:00:00.000Z"),
        new Date("2026-07-17T00:00:00.000Z"),
      ),
      utimes(
        newPath,
        new Date("2026-07-19T00:00:00.000Z"),
        new Date("2026-07-19T00:00:00.000Z"),
      ),
    ]);

    const result = await discoverSessions({
      device: "test",
      includeSubagents: false,
      sources: ["codex"],
      paths: { claude: [], codex: [root], grok: [], cursor: [] },
      modifiedAfter: { codex: "2026-07-18T00:00:00.000Z" },
      includePaths: [],
    });

    expect(result.status.codex.discovered).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("returns no sessions when the abort signal is already set", async () => {
    const root = await mkdtemp(join(tmpdir(), "brainhub-discovery-abort-"));
    const claude = join(root, "project", "session.jsonl");
    await mkdir(dirname(claude), { recursive: true });
    await cp(join(fixtures, "claude", "top-level.jsonl"), claude);
    const signal = AbortSignal.abort();
    const started = Date.now();
    const result = await discoverSessions({
      device: "test",
      includeSubagents: false,
      sources: ["claude-code", "codex", "grok-build", "cursor", "gemini-cli"],
      paths: {
        claude: [root],
        codex: [root],
        grok: [root],
        cursor: [root],
        gemini: [root],
      },
      signal,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.sessions).toEqual([]);
    expect(result.status.claude.discovered).toBe(0);
  });

  it("reports the same sessions through onParsed without retaining them", async () => {
    const root = await mkdtemp(join(tmpdir(), "brainhub-discovery-stream-"));
    const older = join(root, "older.jsonl");
    const newer = join(root, "newer.jsonl");
    await mkdir(root, { recursive: true });
    await writeDiscoverySession(older, "older", "2026-07-18T01:00:00.000Z");
    await writeDiscoverySession(newer, "newer", "2026-07-18T02:00:00.000Z");
    const options = {
      device: "test",
      includeSubagents: false,
      keepToolCalls: false,
      redact: true,
      sources: ["claude-code"] as const,
      paths: { claude: [root], codex: [], grok: [], cursor: [] },
    };
    const full = await discoverSessions({ ...options, sources: [...options.sources] });
    const seen: typeof full.sessions = [];
    const streamed = await discoverSessions({
      ...options,
      sources: [...options.sources],
      retainSessions: false,
      onParsed: (_path, session) => {
        if (session) seen.push(session);
      },
    });
    const byIdentity = (left: (typeof full.sessions)[number], right: (typeof full.sessions)[number]) =>
      left.updatedAt.localeCompare(right.updatedAt) ||
      left.conversationId.localeCompare(right.conversationId) ||
      left.sourcePath.localeCompare(right.sourcePath);
    expect(streamed.sessions).toEqual([]);
    expect(streamed.malformed).toBe(full.malformed);
    expect(streamed.skippedSubagents).toBe(full.skippedSubagents);
    expect([...seen].sort(byIdentity)).toEqual([...full.sessions].sort(byIdentity));
  });

  it("leaves a skipped file unread and uncaptured", async () => {
    const root = await mkdtemp(join(tmpdir(), "brainhub-discovery-skip-"));
    const path = join(root, "session.jsonl");
    await mkdir(root, { recursive: true });
    await writeDiscoverySession(path, "skipped", "2026-07-18T01:00:00.000Z");
    let parsed = 0;
    const result = await discoverSessions({
      device: "test",
      includeSubagents: false,
      sources: ["claude-code"],
      paths: { claude: [root], codex: [], grok: [], cursor: [] },
      skipFile: () => true,
      onParsed: () => {
        parsed += 1;
      },
    });
    expect(parsed).toBe(0);
    expect(result.sessions).toEqual([]);
    expect(result.status.claude).toMatchObject({ discovered: 1, captured: 0 });
  });
});

async function writeDiscoverySession(path: string, id: string, timestamp: string): Promise<void> {
  const line = JSON.stringify({
    type: "user",
    isSidechain: false,
    sessionId: id,
    timestamp,
    message: { role: "user", content: `hello ${id}` },
  });
  await writeFile(path, `${line}\n`);
}
