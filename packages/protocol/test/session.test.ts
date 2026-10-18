import { createHash } from "node:crypto";

import { describe, expect, it } from "bun:test";

import { conversationKey } from "../src/index.js";

const REFERENCE_PATH =
  "/Users/john/private/ai/ai-session-mcp/src/domain/session.ts";

function sha256(source: string, conversationId: string, separator: string): string {
  return createHash("sha256")
    .update(source)
    .update(separator)
    .update(conversationId)
    .digest("hex");
}

describe("conversationKey", () => {
  it("matches BrainHub session.ts for the codex/abc vector", async () => {
    const reference = (await import(REFERENCE_PATH)) as {
      conversationKey: (source: string, conversationId: string) => string;
    };
    expect(conversationKey("codex", "abc")).toBe(
      "0500ad38d366d7c1f7bc8f7e7e1b03a54410aa6385e15f10d1077c0038867dc2",
    );
    expect(conversationKey("codex", "abc")).toBe(
      reference.conversationKey("codex", "abc"),
    );
    expect(conversationKey("claude-code", "abc")).toBe(
      reference.conversationKey("claude-code", "abc"),
    );
    expect(conversationKey("codex", "abc")).toBe(sha256("codex", "abc", "\0"));
    expect(conversationKey("codex", "abc")).not.toBe(sha256("codex", "abc", ""));
    expect(conversationKey("codex", "abc")).not.toBe(sha256("codex", "abc", "/"));
    expect(conversationKey("ab", "c")).not.toBe(conversationKey("a", "bc"));
    expect(conversationKey("codex", "abc")).not.toBe(
      conversationKey("claude-code", "abc"),
    );
  });
});
