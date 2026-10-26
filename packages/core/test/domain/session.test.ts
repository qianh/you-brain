import { describe, expect, it } from "bun:test";

import {
  LEGACY_BACKFILL_SOURCES,
  NormalizedMessageSchema,
  NormalizedSessionSchema,
  SESSION_SOURCES,
  SessionSourceSchema,
  conversationKey,
} from "../../src/domain/session.js";

describe("session domain", () => {
  it("accepts the local sources, including gemini-cli, pi, and t3-code", () => {
    expect(SESSION_SOURCES).toEqual([
      "claude-code",
      "codex",
      "grok-build",
      "cursor",
      "gemini-cli",
      "pi",
      "t3-code",
    ]);
    expect(SessionSourceSchema.parse("gemini-cli")).toBe("gemini-cli");
    expect(SessionSourceSchema.parse("pi")).toBe("pi");
    expect(SessionSourceSchema.parse("t3-code")).toBe("t3-code");
    expect(() => SessionSourceSchema.parse("gemini")).toThrow();
    expect(LEGACY_BACKFILL_SOURCES).toEqual([
      "claude-code",
      "codex",
      "grok-build",
    ]);
  });

  it("builds the same key as BrainHub", () => {
    expect(conversationKey("codex", "abc")).toBe(
      "0500ad38d366d7c1f7bc8f7e7e1b03a54410aa6385e15f10d1077c0038867dc2",
    );
    expect(conversationKey("codex", "abc")).toMatch(/^[a-f0-9]{64}$/);
    expect(conversationKey("codex", "abc")).not.toBe(
      conversationKey("claude-code", "abc"),
    );
  });

  it("rejects sessions with non-ISO timestamps, no visible turns, or a reversed clock", () => {
    const message = { role: "user" as const, text: "hello", images: [] };
    const base = {
      source: "codex" as const,
      conversationId: "abc",
      device: "macbook",
      startedAt: "2026-07-19T01:00:00.000Z",
      updatedAt: "2026-07-19T02:00:00.000Z",
      sourcePath: "/tmp/session.jsonl",
      turns: [message],
      warnings: [],
    };

    expect(NormalizedSessionSchema.parse(base)).toMatchObject(base);
    expect(NormalizedMessageSchema.parse(message)).toEqual(message);
    expect(() =>
      NormalizedSessionSchema.parse({ ...base, startedAt: "yesterday" }),
    ).toThrow();
    expect(() => NormalizedSessionSchema.parse({ ...base, turns: [] })).toThrow();
    expect(() =>
      NormalizedSessionSchema.parse({
        ...base,
        updatedAt: "2026-07-19T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      NormalizedSessionSchema.parse({
        ...base,
        turns: [
          {
            role: "user",
            text: "see",
            images: [{ kind: "remote", url: "not a url" }],
          },
        ],
      }),
    ).toThrow();
    expect(
      NormalizedSessionSchema.parse({
        ...base,
        source: "gemini-cli",
        turns: [
          {
            role: "assistant",
            text: "ok",
            images: [
              { kind: "embedded", mediaType: "image/png", data: "aaaa" },
              { kind: "remote", url: "https://example.com/a.png" },
            ],
          },
        ],
      }).source,
    ).toBe("gemini-cli");
  });
});
