import { describe, expect, test } from "bun:test";

import { renderSessionMarkdown } from "../../src/capture/normalize.js";
import type { NormalizedSession } from "../../src/domain/session.js";
import { frontmatter, parseWebSession } from "../../src/web-sessions/parse.js";

const STARTED = "2026-10-18T01:00:00.000Z";
const UPDATED = "2026-10-18T01:05:00.000Z";

function rendered(patch?: Partial<NormalizedSession>): string {
  const session = {
    source: "chatgpt-web",
    conversationId: "conv-1",
    device: "chrome",
    startedAt: STARTED,
    updatedAt: UPDATED,
    turns: [
      {
        role: "user",
        text: "see this",
        images: [{ kind: "remote", url: "https://example.com/a.png" }],
      },
      { role: "assistant", text: "noted", images: [] },
    ],
    sourcePath: "inbox/web-chrome/conv-1.md",
    warnings: [],
    ...patch,
  } as NormalizedSession;
  return renderSessionMarkdown(session, {
    redactionVersion: 1,
    redactionCount: 0,
    imageReferences: new Map(),
  }).markdown;
}

describe("parseWebSession", () => {
  test("round-trips rendered markdown and keeps image lines as text", () => {
    const markdown = rendered().replace("turn_count: 2", "turn_count: 9");
    const parsed = parseWebSession(markdown);
    expect(parsed).toEqual({
      source: "chatgpt-web",
      conversationId: "conv-1",
      device: "chrome",
      startedAt: STARTED,
      updatedAt: UPDATED,
      turnCount: 2,
      turns: [
        { role: "user", text: "see this\n\n![](https://example.com/a.png)" },
        { role: "assistant", text: "noted" },
      ],
    });
    expect(frontmatter(markdown).get("turn_count")).toBe("9");
    expect(frontmatter(markdown).get("source")).toBe("chatgpt-web");
  });

  test("returns null when a required field is missing and allows a missing device", () => {
    for (const field of ["source", "conversation_id", "started_at", "updated_at"]) {
      const markdown = rendered().replace(new RegExp(`^${field}:.*$`, "mu"), `${field}:`);
      expect(parseWebSession(markdown)).toBeNull();
    }
    const withoutDevice = rendered().replace(/^device:.*\n/mu, "");
    expect(parseWebSession(withoutDevice)?.device).toBe("");
    expect(parseWebSession("no frontmatter\n## User\nhello\n")).toBeNull();
  });

  test("splits only on User and Assistant headings, drops empty turns, and accepts CRLF", () => {
    const markdown = [
      "---",
      "source: gemini-web",
      "conversation_id: conv-2",
      "device: chrome",
      `started_at: ${STARTED}`,
      `updated_at: ${UPDATED}`,
      "turn_count: 8",
      "---",
      "preamble stays out",
      "## User  ",
      "before",
      "## Other",
      "still the user",
      "see ## Assistant here",
      "## Assistant",
      "   ",
      "## User",
      "",
      "## Assistant",
      "kept",
      "",
    ].join("\n");
    expect(parseWebSession(markdown)).toEqual({
      source: "gemini-web",
      conversationId: "conv-2",
      device: "chrome",
      startedAt: STARTED,
      updatedAt: UPDATED,
      turnCount: 2,
      turns: [
        { role: "user", text: "before\n## Other\nstill the user\nsee ## Assistant here" },
        { role: "assistant", text: "kept" },
      ],
    });
    expect(parseWebSession(markdown.replaceAll("\n", "\r\n"))).toEqual(parseWebSession(markdown));
  });
});
