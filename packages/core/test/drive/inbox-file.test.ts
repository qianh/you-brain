import { describe, expect, it } from "bun:test";

import { isInboxSessionFile } from "../../src/drive/inbox-file.js";

describe("inbox session file", () => {
  it("accepts uploaded session markdown", () => {
    expect(
      isInboxSessionFile({
        path: "inbox/Johns-MacBook-Pro-2.local/grok-build-20261026-abcd1234-title.md",
        mimeType: "text/markdown",
      }),
    ).toBe(true);
    expect(isInboxSessionFile({ path: "inbox/dev/a.md" })).toBe(true);
  });

  it("rejects the plugin's half-written temporary file", () => {
    // Written with `text/markdown` as its declared type, so a type check alone accepted
    // it and produced a phantom second session for the same conversation.
    expect(
      isInboxSessionFile({
        path: "inbox/web-chrome/.2b4660d0-4d4a-4c9c-8f1b-b0c1bd5331e2.tmp",
        mimeType: "text/markdown",
      }),
    ).toBe(false);
    expect(isInboxSessionFile({ path: "inbox/dev/notes.tmp", mimeType: "text/markdown" })).toBe(
      false,
    );
    expect(isInboxSessionFile({ path: "inbox/dev/.hidden.md" })).toBe(false);
  });

  it("ignores paths outside the inbox", () => {
    expect(isInboxSessionFile({ path: "you-brain/shared.json", mimeType: "application/json" })).toBe(
      false,
    );
    expect(isInboxSessionFile({ path: "topics/TOPICS-latest.md" })).toBe(false);
    expect(isInboxSessionFile({ path: "inbox", mimeType: "text/markdown" })).toBe(false);
  });
});
