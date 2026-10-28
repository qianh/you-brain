import { resolve } from "node:path";

import { describe, expect, it } from "bun:test";

import { claudeAdapter, parseClaudeSession } from "../../src/adapters/claude.js";
import { cursorAdapter } from "../../src/adapters/cursor.js";
import {
  getAdapter,
  listAdapters,
  registerAdapter,
  unregisterAdapter,
} from "../../src/adapters/registry.js";
import {
  resolveCaptureOptions,
  type SourceAdapter,
} from "../../src/adapters/types.js";

const fixture = (...parts: string[]) =>
  resolve(import.meta.dirname, "..", "fixtures", ...parts);

describe("adapter registry", () => {
  it("registers the eight built-in sources and their default roots", () => {
    expect(listAdapters().map((adapter) => adapter.id)).toEqual([
      "claude-code",
      "codex",
      "grok-build",
      "cursor",
      "gemini-cli",
      "pi",
      "t3-code",
      "zcode",
    ]);
    expect(claudeAdapter.defaultRoots("/Users/me")).toEqual([
      "/Users/me/.claude/projects",
    ]);
    expect(getAdapter("codex")?.defaultRoots("/Users/me")).toEqual([
      "/Users/me/.codex/sessions",
    ]);
    expect(getAdapter("grok-build")?.defaultRoots("/Users/me")).toEqual([
      "/Users/me/.grok/sessions",
    ]);
    expect(getAdapter("cursor")?.defaultRoots("/Users/me")).toEqual([
      "/Users/me/.cursor/projects",
    ]);
    expect(getAdapter("gemini-cli")?.defaultRoots("/Users/me")).toEqual([
      "/Users/me/.gemini/tmp",
    ]);
    expect(getAdapter("pi")?.defaultRoots("/Users/me")).toEqual([
      "/Users/me/.pi/agent/sessions",
    ]);
    expect(getAdapter("t3-code")?.defaultRoots("/Users/me")).toEqual([
      "/Users/me/.t3/userdata",
    ]);
    expect(getAdapter("zcode")?.defaultRoots("/Users/me")).toEqual([
      "/Users/me/.zcode/cli/db",
    ]);
  });

  it("lets a caller register and remove a community adapter", () => {
    const custom: SourceAdapter = {
      id: "example-cli",
      defaultRoots: () => ["/tmp/example"],
      async *discover() {
        /* empty */
      },
      parse: async () => [],
    };
    registerAdapter(custom);
    expect(getAdapter("example-cli")).toBe(custom);
    unregisterAdapter("example-cli");
    expect(getAdapter("example-cli")).toBeUndefined();
    expect(listAdapters().some((adapter) => adapter.id === "example-cli")).toBe(
      false,
    );
  });

  it("redacts by default and can keep a truncated tool call", async () => {
    expect(resolveCaptureOptions({ device: "test" })).toMatchObject({
      includeSubagents: false,
      keepToolCalls: false,
      redact: true,
      toolCallMaxChars: 2000,
    });

    const redacted = await cursorAdapter.parse(
      { path: fixture("cursor", "top-level.jsonl"), source: "cursor" },
      { device: "test-device" },
    );
    expect(redacted[0]?.turns[0]?.text).toContain("[REDACTED]");
    expect(redacted[0]?.turns[0]?.text).not.toContain("cursor-secret-value");

    const raw = await cursorAdapter.parse(
      { path: fixture("cursor", "top-level.jsonl"), source: "cursor" },
      { device: "test-device", redact: false },
    );
    expect(raw[0]?.turns[0]?.text).toContain("cursor-secret-value");

    const withTools = await claudeAdapter.parse(
      { path: fixture("claude", "top-level.jsonl"), source: "claude-code" },
      { device: "test-device", redact: false, keepToolCalls: true, toolCallMaxChars: 18 },
    );
    expect(withTools[0]?.turns[1]?.text.startsWith("Use a staged rollout.\n\n[tool]")).toBe(
      true,
    );
    expect(withTools[0]?.turns[1]?.text).toContain("…");
    expect(withTools[0]?.turns[1]?.text).not.toContain("cat secret");

    const defaults = await parseClaudeSession(fixture("claude", "top-level.jsonl"), {
      device: "test-device",
      includeSubagents: false,
    });
    expect(defaults.session?.turns[1]?.text).toBe("Use a staged rollout.");
  });
});
