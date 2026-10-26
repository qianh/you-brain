import { describe, expect, it } from "bun:test";

import { isConversation, isInjectedPrompt } from "../../src/adapters/conversation.js";
import type { Turn } from "../../src/domain/session.js";

const turn = (role: "user" | "assistant", text: string): Turn => ({
  role,
  text,
  images: [],
});

describe("conversation filter", () => {
  it("recognises the context a CLI injects before the user types anything", () => {
    expect(isInjectedPrompt("# AGENTS.md instructions for /Users/me/project")).toBe(true);
    expect(isInjectedPrompt("<environment_context>\n  <cwd>/tmp</cwd>")).toBe(true);
    expect(isInjectedPrompt("<user_instructions>\n# Guidelines")).toBe(true);
    expect(isInjectedPrompt("<recommended_plugins>\nHere is a list")).toBe(true);
    expect(isInjectedPrompt("   <environment_context>")).toBe(true);
    expect(isInjectedPrompt("why does this test fail")).toBe(false);
    expect(isInjectedPrompt("")).toBe(false);
  });

  it("drops a session that only holds the injected AGENTS.md prompt", () => {
    // Opening Codex and closing it again leaves exactly this.
    const turns = [
      turn("user", "# AGENTS.md instructions for /Users/me/project\n<INSTRUCTIONS>…"),
    ];
    expect(isConversation(turns)).toBe(false);
  });

  it("drops a session with an injected prompt and a reply but no real question", () => {
    const turns = [
      turn("user", "<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>"),
      turn("assistant", "Understood."),
    ];
    expect(isConversation(turns)).toBe(false);
  });

  it("keeps a question the model has not answered yet", () => {
    // The session is captured while it is still being written; waiting for a reply
    // would drop the conversation the user is having right now.
    expect(isConversation([turn("user", "how do I merge two branches")])).toBe(true);
    expect(
      isConversation([turn("user", "how do I merge two branches"), turn("user", "hello?")]),
    ).toBe(true);
  });

  it("drops a session whose user turn is blank", () => {
    expect(isConversation([turn("user", "   "), turn("assistant", "…")])).toBe(false);
  });

  it("keeps a real exchange, even when the injected prompt comes first", () => {
    const turns = [
      turn("user", "# AGENTS.md instructions for /Users/me/project"),
      turn("user", "why does the build fail"),
      turn("assistant", "Because the lockfile is stale."),
    ];
    expect(isConversation(turns)).toBe(true);
  });

  it("drops a session that holds only assistant text", () => {
    expect(isConversation([turn("assistant", "anything I can help with?")])).toBe(false);
  });
});
