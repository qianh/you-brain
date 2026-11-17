import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { Embedder } from "../../src/search/embedder.js";
import { SearchService } from "../../src/search/search-service.js";
import { MemoryDrive } from "./memory-drive.js";

const embedder: Embedder = {
  model: "fast",
  revision: "v1",
  dimensions: 2,
  embedQuery: () => Promise.resolve([1, 0]),
  embedPassages: (texts) => Promise.resolve(texts.map(() => [1, 0])),
};

const HEADER = `---
source: codex
conversation_id: conv-header
device: test-mac
started_at: 2026-07-18T01:00:00.000Z
updated_at: 2026-07-18T02:00:00.000Z
content_sha256: ${"b".repeat(64)}
---
`;

const filler = (count: number): string => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");

describe("search excerpts and the session header", () => {
  it("indexes the transcript without the YAML header", async () => {
    const drive = new MemoryDrive();
    await drive.put({ path: "inbox/mac/a.md", bytes: new TextEncoder().encode(`${HEADER}## User\nkiwi orchard\n`), mimeType: "text/markdown" });
    const database = new Database(":memory:");
    await new SearchService({ drive, embedder, database }).sync();
    const texts = (database.prepare("SELECT text FROM search_chunks").all() as Array<{ text: string }>).map((row) => row.text);
    expect(texts.join("\n")).toContain("kiwi orchard");
    expect(texts.join("\n")).not.toContain("content_sha256");
    // The header still fills the metadata columns.
    const meta = database.prepare("SELECT source, conversation_id FROM search_chunks LIMIT 1").get();
    expect(meta).toEqual({ source: "codex", conversation_id: "conv-header" });
  });

  it("hides the header of chunks indexed before, and shows the text around the query", async () => {
    const drive = new MemoryDrive();
    await drive.put({ path: "inbox/mac/a.md", bytes: new TextEncoder().encode(`${HEADER}## User\n${filler(10)}\n`), mimeType: "text/markdown" });
    const database = new Database(":memory:");
    const search = new SearchService({ drive, embedder, database });
    await search.sync();
    // An old-format chunk: header included, the match far past the first 360 characters.
    database
      .prepare("UPDATE search_chunks SET text = ?")
      .run(`${HEADER}## User\n${filler(120)} kiwi orchard ${filler(20)}`);
    const found = await search.query({ query: "kiwi", limit: 1, remote: false });
    const excerpt = found.results[0]?.excerpt ?? "";
    expect(excerpt).not.toContain("content_sha256");
    expect(excerpt).not.toStartWith("---");
    expect(excerpt).toContain("kiwi orchard");
  });
});
