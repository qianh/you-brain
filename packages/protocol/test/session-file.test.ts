import { describe, expect, it } from "bun:test";

import { parseSessionFrontmatter, sessionFrontmatterFields } from "../src/index.js";

const MARKDOWN = `---
source: claude-web
conversation_id: conv-1
started_at: 2026-10-18T02:00:00.000Z
updated_at: 2026-10-18T03:00:00.000Z
turn_count: 2
---
## User
你好
`;

describe("parseSessionFrontmatter", () => {
  it("reads the required fields and keeps the rest", () => {
    const parsed = parseSessionFrontmatter(MARKDOWN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontmatter.source).toBe("claude-web");
    expect(parsed.frontmatter.conversation_id).toBe("conv-1");
    expect(parsed.frontmatter.device).toBe("");
    expect(parsed.frontmatter.fields.turn_count).toBe("2");
  });

  it("reports one error when the block is missing", () => {
    expect(parseSessionFrontmatter("## User\n")).toEqual({
      ok: false,
      errors: [{ path: "frontmatter", message: "缺少 frontmatter" }],
    });
  });

  it("reports a missing required field with its line", () => {
    const parsed = parseSessionFrontmatter("---\nsource: web\n---\n");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.map((error) => error.path)).toEqual([
      "conversation_id",
      "started_at",
      "updated_at",
    ]);
    expect(parsed.errors.every((error) => error.line === undefined)).toBe(true);
  });

  it("matches the field map used by uploaded sessions, including CRLF and duplicates", () => {
    const text = "---\r\nsource: a\r\n:skip\r\nsource: b\r\nno-colon\r\n---\r\n";
    const fields = sessionFrontmatterFields(text);
    expect(fields.get("source")).toBe("b");
    expect(fields.has("no-colon")).toBe(false);
    expect([...fields.keys()]).toEqual(["source"]);
    expect(sessionFrontmatterFields("no block")).toEqual(new Map());
  });
});
