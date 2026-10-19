import { createHash } from "node:crypto";

import { describe, expect, it } from "bun:test";

import { conversationKey } from "../src/index.js";

// Vectors produced by BrainHub's conversationKey (src/domain/session.ts).
const BRAINHUB_VECTORS = {
  codexAbc: "0500ad38d366d7c1f7bc8f7e7e1b03a54410aa6385e15f10d1077c0038867dc2",
  claudeCodeAbc: "ecd1226b22d0c489e2e0ff09b4aca1658a810ab44865026f0a01218a24664b0a",
};

function sha256(source: string, conversationId: string, separator: string): string {
  return createHash("sha256")
    .update(source)
    .update(separator)
    .update(conversationId)
    .digest("hex");
}

describe("conversationKey", () => {
  it("matches BrainHub session.ts for the codex/abc vector", () => {
    expect(conversationKey("codex", "abc")).toBe(BRAINHUB_VECTORS.codexAbc);
    expect(conversationKey("claude-code", "abc")).toBe(BRAINHUB_VECTORS.claudeCodeAbc);
    expect(conversationKey("codex", "abc")).toBe(sha256("codex", "abc", "\0"));
    expect(conversationKey("codex", "abc")).not.toBe(sha256("codex", "abc", ""));
    expect(conversationKey("codex", "abc")).not.toBe(sha256("codex", "abc", "/"));
    expect(conversationKey("ab", "c")).not.toBe(conversationKey("a", "bc"));
    expect(conversationKey("codex", "abc")).not.toBe(
      conversationKey("claude-code", "abc"),
    );
  });
});
