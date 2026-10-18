import { describe, expect, it } from "bun:test";

import { renderSessionMarkdown } from "../../src/capture/normalize.js";
import { applyCaptureRedaction, redactSession } from "../../src/capture/redact.js";
import type { NormalizedSession } from "../../src/domain/session.js";

const session: NormalizedSession = {
  source: "cursor",
  conversationId: "cursor-1",
  device: "test",
  startedAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:01:00.000Z",
  sourcePath: "/tmp/cursor.jsonl",
  warnings: [],
  turns: [
    {
      role: "user",
      text: "Authorization: Bearer cursor-secret-value",
      images: [],
    },
  ],
};

describe("capture options", () => {
  it("redacts when the switch is on and leaves the markdown layout unchanged", () => {
    const redacted = redactSession(session);
    expect(redacted.count).toBe(1);
    expect(redacted.session.turns[0]?.text).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    const skipped = applyCaptureRedaction(session, {
      redact: false,
      redaction: {},
    });
    expect(skipped.session.turns[0]?.text).toContain("cursor-secret-value");

    const rendered = renderSessionMarkdown(redacted.session, {
      redactionVersion: redacted.version,
      redactionCount: redacted.count,
      imageReferences: new Map(),
    });
    expect(rendered.markdown.startsWith("---\nsource: cursor\n")).toBe(true);
    expect(rendered.markdown).toContain("redaction_version: 1\n");
    expect(rendered.markdown).toContain("redaction_count: 1\n");
    expect(rendered.markdown).toContain(
      "content_sha256: " + rendered.contentSha256,
    );
    expect(rendered.markdown.endsWith("## User\nAuthorization: Bearer [REDACTED]\n")).toBe(
      true,
    );
  });
});
