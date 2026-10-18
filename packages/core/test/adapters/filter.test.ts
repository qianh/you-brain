import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { discoverSessions } from "../../src/adapters/index.js";
import { allowCapturePath } from "../../src/adapters/filter.js";

describe("capture path filters", () => {
  it("lets an exclude directory win over an include glob", () => {
    const file = "/root/proj/hidden/session.jsonl";
    expect(allowCapturePath(file, [], ["hidden"])).toBe(false);
    expect(allowCapturePath("/root/proj/hidden/file", [], ["hidden"])).toBe(false);
    expect(allowCapturePath("/root/visible/session.jsonl", [], ["hidden"])).toBe(true);
    expect(allowCapturePath("/root/visible/session.jsonl", ["**/*.jsonl"], ["hidden"])).toBe(true);
    expect(allowCapturePath("/root/proj/hidden/session.jsonl", ["**/*.jsonl"], ["hidden"])).toBe(
      false,
    );
    expect(allowCapturePath("/tmp/keep/a.jsonl", ["/tmp/keep"], [])).toBe(true);
    expect(allowCapturePath("/tmp/drop/a.jsonl", ["/tmp/keep"], [])).toBe(false);
  });

  it("passes keepToolCalls, redact, and include/exclude into discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-filter-"));
    const visible = join(root, "visible.jsonl");
    const hiddenDir = join(root, "hidden");
    await mkdir(hiddenDir, { recursive: true });
    const line = (sessionId: string, text: string) =>
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        sessionId,
        timestamp: "2026-10-18T02:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text },
            { type: "tool_use", name: "Read", input: { path: "a.ts" } },
          ],
        },
      });
    await writeFile(visible, `${line("visible-1", "Authorization: Bearer cursor-secret-value")}\n`);
    await writeFile(
      join(hiddenDir, "secret.jsonl"),
      `${line("hidden-1", "Authorization: Bearer cursor-secret-value")}\n`,
    );

    const discovered = await discoverSessions({
      device: "test",
      includeSubagents: false,
      keepToolCalls: true,
      redact: true,
      sourceFilters: { "claude-code": { include: [], exclude: ["hidden"] } },
      sources: ["claude-code"],
      paths: { claude: [root], codex: [], grok: [], cursor: [], gemini: [] },
    });
    expect(discovered.sessions.map((session) => session.conversationId)).toEqual(["visible-1"]);
    const text = discovered.sessions[0]?.turns.map((turn) => turn.text).join("\n") ?? "";
    expect(text).toContain("[tool] Read");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("cursor-secret-value");
    expect(discovered.status.claude.discovered).toBe(1);
  });
});
