import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import { discoverSessions } from "../../src/adapters/index.js";
import { parsePiSession } from "../../src/adapters/pi.js";

const fixture = (...parts: string[]) =>
  resolve(import.meta.dirname, "..", "fixtures", ...parts);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pi adapter", () => {
  it("keeps visible user and assistant text and drops system, thinking, and tool results", async () => {
    const result = await parsePiSession(fixture("pi", "session.jsonl"), {
      device: "test-device",
      includeSubagents: false,
    });

    expect(result.session?.source).toBe("pi");
    expect(result.session?.conversationId).toBe("pi-session-1");
    expect(result.session?.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "List the files"],
      ["assistant", "There are two files."],
      ["user", "Thanks"],
    ]);
    expect(result.session?.startedAt).toBe("2026-10-18T07:51:13.253Z");
    expect(result.session?.updatedAt).toBe("2026-10-18T07:53:00.000Z");
    const encoded = JSON.stringify(result.session);
    expect(encoded).not.toContain("secret system preamble");
    expect(encoded).not.toContain("private thought");
    expect(encoded).not.toContain("secret-tool-output");
    expect(encoded).not.toContain("some-model");
  });

  it("includes tool calls only when keepToolCalls is set", async () => {
    const withTools = await parsePiSession(fixture("pi", "session.jsonl"), {
      device: "test-device",
      includeSubagents: false,
      keepToolCalls: true,
    });

    expect(withTools.session?.turns[1]?.text).toContain("bash");
    expect(withTools.session?.turns[1]?.text).toContain("There are two files.");
  });

  it("falls back to the session id in the filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-pi-id-"));
    roots.push(root);
    const path = join(
      root,
      "2026-10-18T07-51-13-253Z_01a14dfe-4a64-73a9-a0ba-e83820309b2c.jsonl",
    );
    await writeFile(
      path,
      `${[
        JSON.stringify({
          type: "session",
          version: 3,
          timestamp: "2026-10-18T07:51:13.253Z",
          cwd: "/Users/tester/project",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-10-18T07:52:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-10-18T07:52:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        }),
      ].join("\n")}\n`,
    );

    const result = await parsePiSession(path, {
      device: "test-device",
      includeSubagents: false,
    });

    expect(result.session?.conversationId).toBe(
      "01a14dfe-4a64-73a9-a0ba-e83820309b2c",
    );
  });

  it("drops sessions produced by the subscription CLI work directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-pi-cli-"));
    roots.push(root);
    const workDir = join(root, "llm-cli");
    await mkdir(workDir, { recursive: true });
    const path = join(root, "session.jsonl");
    await writeFile(
      path,
      `${[
        JSON.stringify({
          type: "session",
          version: 3,
          id: "cli-session",
          timestamp: "2026-10-18T07:51:13.253Z",
          cwd: workDir,
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-10-18T07:52:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "hello" }] },
        }),
      ].join("\n")}\n`,
    );

    const result = await parsePiSession(path, {
      device: "test-device",
      includeSubagents: false,
      llmCliWorkDir: workDir,
    });

    expect(result.session).toBeNull();
  });

  it("is discovered through the shared discovery entry point", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-pi-discover-"));
    roots.push(root);
    const nested = join(root, "--Users-tester-project--");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "session.jsonl"),
      await Bun.file(fixture("pi", "session.jsonl")).text(),
    );

    const result = await discoverSessions({
      device: "test-device",
      includeSubagents: false,
      sources: ["pi"],
      paths: { claude: [], codex: [], grok: [], cursor: [], pi: [root] },
    });

    expect(result.status.pi).toMatchObject({ discovered: 1, captured: 1 });
    expect(result.sessions.map((session) => session.source)).toEqual(["pi"]);
  });
});
