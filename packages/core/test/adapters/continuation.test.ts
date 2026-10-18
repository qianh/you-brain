import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { parseCodexSession } from "../../src/adapters/codex.js";
import {
  clearContinuationIndex,
  continuationByPrefix,
  messagePrefixHash,
  resolveContinuation,
} from "../../src/adapters/continuation.js";
import { parseGrokSession } from "../../src/adapters/grok.js";
import type { NormalizedSession, Turn } from "../../src/domain/session.js";

function session(
  conversationId: string,
  texts: string[],
  startedAt: string,
  source: NormalizedSession["source"] = "claude-code",
): NormalizedSession {
  const turns: Turn[] = texts.map((text, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    images: [],
  }));
  return {
    source,
    conversationId,
    device: "test",
    startedAt,
    updatedAt: startedAt,
    sourcePath: `/tmp/${conversationId}`,
    warnings: [],
    turns,
  };
}

describe("continuation", () => {
  it("hashes a message prefix independently of later turns", () => {
    const early = session("a", ["one", "two", "three"], "2026-07-18T00:00:00.000Z");
    const later = session("b", ["one", "two", "different"], "2026-07-18T01:00:00.000Z");
    expect(messagePrefixHash(early.turns, 2)).toBe(
      messagePrefixHash(later.turns, 2),
    );
    expect(messagePrefixHash(early.turns, 3)).not.toBe(
      messagePrefixHash(later.turns, 3),
    );
  });

  it("returns the closest copied ancestor when the new session extends it", () => {
    const root = session(
      "root",
      ["one", "two"],
      "2026-07-18T00:00:00.000Z",
    );
    const parent = session(
      "parent",
      ["one", "two", "three", "four"],
      "2026-07-18T01:00:00.000Z",
    );
    const child = session(
      "child",
      ["one", "two", "three", "four", "five", "six"],
      "2026-07-18T02:00:00.000Z",
    );
    const unrelated = session(
      "other",
      ["one", "two", "nope", "nope"],
      "2026-07-18T00:30:00.000Z",
    );
    expect(continuationByPrefix(child, [root, parent, unrelated])).toBe("parent");
    expect(continuationByPrefix(parent, [root, child])).toBe("root");
    expect(resolveContinuation(child, [root, parent])).toBe("parent");
  });

  it("does not link sessions that only share an opening and then diverge", () => {
    const left = session("left", ["hi", "hello", "left"], "2026-07-18T00:00:00.000Z");
    const right = session("right", ["hi", "hello", "right"], "2026-07-18T01:00:00.000Z");
    expect(continuationByPrefix(right, [left])).toBeNull();
  });

  it("prefers Codex forked_from_id over the content prefix", async () => {
    clearContinuationIndex();
    const directory = await mkdtemp(join(tmpdir(), "you-brain-codex-fork-"));
    const path = join(directory, "rollout-fork.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify({
          timestamp: "2026-07-18T11:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "codex-child",
            timestamp: "2026-07-18T11:00:00.000Z",
            forked_from_id: "codex-parent",
            source: "cli",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-18T11:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "copied prompt" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-18T11:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "copied answer" }],
          },
        }),
      ].join("\n"),
    );
    const result = await parseCodexSession(path, {
      device: "test-device",
      includeSubagents: false,
    });
    const parsed = result.session;
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    const decoy = session(
      "decoy",
      ["copied prompt", "copied answer"],
      "2026-07-18T10:00:00.000Z",
      "codex",
    );
    expect(resolveContinuation(parsed, [decoy])).toBe("codex-parent");
  });

  it("reads Grok parent_session_id from summary.json", async () => {
    clearContinuationIndex();
    const directory = await mkdtemp(join(tmpdir(), "you-brain-grok-fork-"));
    await writeFile(
      join(directory, "summary.json"),
      JSON.stringify({
        created_at: "2026-07-18T12:00:00.000Z",
        updated_at: "2026-07-18T12:03:00.000Z",
        session_kind: "main",
        parent_session_id: "grok-parent",
      }),
    );
    await writeFile(
      join(directory, "chat_history.jsonl"),
      `${JSON.stringify({ type: "user", content: "Continue" })}\n${JSON.stringify({ type: "assistant", content: "Continued." })}\n`,
    );
    const result = await parseGrokSession(directory, {
      device: "test-device",
      includeSubagents: false,
    });
    expect(result.session).not.toBeNull();
    if (!result.session) return;
    expect(resolveContinuation(result.session, [])).toBe("grok-parent");
  });
});
