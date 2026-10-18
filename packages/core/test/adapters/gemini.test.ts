import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "bun:test";

import { geminiAdapter, parseGeminiSession } from "../../src/adapters/gemini.js";
import { discoverSessions } from "../../src/adapters/index.js";

const fixture = (...parts: string[]) =>
  resolve(import.meta.dirname, "..", "fixtures", ...parts);

describe("gemini adapter", () => {
  it("reads ConversationRecord messages and drops thoughts, tool results, and info", async () => {
    const result = await parseGeminiSession(fixture("gemini", "top-level.json"), {
      device: "test-device",
      includeSubagents: false,
    });

    expect(result.skippedSubagent).toBe(false);
    expect(result.session?.source).toBe("gemini-cli");
    expect(result.session?.conversationId).toBe("gemini-1");
    expect(result.session?.turns.map((turn) => turn.text)).toEqual([
      "List the files",
      "There are two files.",
    ]);
    const encoded = JSON.stringify(result.session);
    expect(encoded).not.toContain("private thought");
    expect(encoded).not.toContain("secret-tool-output");
    expect(encoded).not.toContain("list_directory");
    expect(encoded).not.toContain("ignored info banner");
  });

  it("skips subagent sessions unless includeSubagents is set", async () => {
    const skipped = await parseGeminiSession(fixture("gemini", "subagent.json"), {
      device: "test-device",
      includeSubagents: false,
    });
    expect(skipped).toEqual({
      session: null,
      skippedSubagent: true,
      malformedLines: 0,
    });

    const kept = await parseGeminiSession(fixture("gemini", "subagent.json"), {
      device: "test-device",
      includeSubagents: true,
    });
    expect(kept.session?.conversationId).toBe("gemini-sub");
    expect(kept.session?.turns.map((turn) => turn.text)).toEqual([
      "internal task",
      "internal answer",
    ]);
  });

  it("keeps truncated tool calls and untyped text parts when asked", async () => {
    const directory = await mkdtemp(join(tmpdir(), "you-brain-gemini-"));
    const chats = join(directory, "project", "chats");
    await mkdir(chats, { recursive: true });
    const path = join(chats, "session-2026-07-18T10-00-parts.json");
    await writeFile(
      path,
      JSON.stringify({
        sessionId: "gemini-parts",
        projectHash: "abc",
        startTime: "2026-07-18T10:00:00.000Z",
        lastUpdated: "2026-07-18T10:02:00.000Z",
        messages: [
          {
            id: "u",
            timestamp: "2026-07-18T10:00:00.000Z",
            type: "user",
            content: [{ text: "Draw a diagram" }],
          },
          {
            id: "g",
            timestamp: "2026-07-18T10:02:00.000Z",
            type: "gemini",
            content: [{ text: "Done." }],
            toolCalls: [
              {
                name: "write_file",
                args: { content: "x".repeat(80) },
              },
            ],
          },
        ],
      }),
    );

    const result = await parseGeminiSession(path, {
      device: "test-device",
      includeSubagents: false,
      keepToolCalls: true,
      toolCallMaxChars: 24,
    });
    const assistant = result.session?.turns[1]?.text ?? "";
    expect(result.session?.turns[0]?.text).toBe("Draw a diagram");
    expect(assistant.startsWith("Done.\n\n[tool] write_file ")).toBe(true);
    expect(assistant.endsWith("…")).toBe(true);
    expect(assistant).not.toContain("x".repeat(20));
    expect(assistant.length).toBe("Done.\n\n".length + 24);

    const files = [];
    for await (const file of geminiAdapter.discover([directory])) files.push(file);
    expect(files).toEqual([{ path, source: "gemini-cli" }]);
  });

  it("discovers session-*.json under chats/", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-gemini-discover-"));
    const chats = join(root, "hash", "chats");
    await mkdir(chats, { recursive: true });
    await cp(fixture("gemini", "top-level.json"), join(chats, "session-a.json"));
    await cp(fixture("gemini", "subagent.json"), join(chats, "session-b.json"));
    await writeFile(join(chats, "notes.json"), "{}");

    const result = await discoverSessions({
      device: "test",
      includeSubagents: false,
      sources: ["gemini-cli"],
      paths: { claude: [], codex: [], grok: [], cursor: [], gemini: [root] },
    });
    expect(result.status.gemini).toMatchObject({
      discovered: 2,
      captured: 1,
      skippedSubagents: 1,
    });
    expect(result.sessions.map((session) => session.conversationId)).toEqual([
      "gemini-1",
    ]);
  });
});
