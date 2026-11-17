import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { Embedder } from "../../src/search/embedder.js";
import { SearchService } from "../../src/search/search-service.js";
import { MemoryDrive } from "./memory-drive.js";

/** Texts mentioning "kiwi" point one way, everything else another, so semantic hits are checkable. */
const embedder: Embedder = {
  model: "fast",
  revision: "v1",
  dimensions: 2,
  embedQuery: (text) => Promise.resolve(text.includes("kiwi") ? [1, 0] : [0, 1]),
  embedPassages: (texts) => Promise.resolve(texts.map((text) => (text.includes("kiwi") ? [1, 0] : [0, 1]))),
};

function markdown(id: string, body: string): Uint8Array {
  return new TextEncoder().encode(`---
source: codex
conversation_id: ${id}
started_at: 2026-07-18T01:00:00.000Z
updated_at: 2026-07-18T02:00:00.000Z
content_sha256: ${"a".repeat(64)}
---
## User
${body}
`);
}

/** Counts full reads of the vector table: the cost a resident cache exists to avoid. */
function countingDatabase(): { database: Database; fullReads: () => number } {
  const database = new Database(":memory:");
  let reads = 0;
  const prepare = database.prepare.bind(database);
  database.prepare = ((sql: string) => {
    if (/SELECT drive_file_id, chunk_id, vector FROM search_vectors\s*$/u.test(sql.trim())) reads += 1;
    return prepare(sql);
  }) as typeof database.prepare;
  return { database, fullReads: () => reads };
}

async function put(drive: MemoryDrive, name: string, body: string): Promise<void> {
  await drive.upsert({ path: `inbox/mac/${name}.md`, bytes: markdown(name, body), mimeType: "text/markdown" });
}

describe("resident vector cache", () => {
  it("is patched, not reread, when the daemon commits new documents", async () => {
    const drive = new MemoryDrive();
    await put(drive, "a", "plain notes");
    const { database, fullReads } = countingDatabase();
    const search = new SearchService({ drive, embedder, database });
    await search.sync();
    await search.warm();
    expect(fullReads()).toBe(1);

    await put(drive, "b", "kiwi orchard");
    await search.sync();
    const found = await search.query({ query: "kiwi", limit: 1, remote: false });
    expect(found.results[0]?.conversationId).toBe("b");
    expect(fullReads()).toBe(1);
  });

  it("is patched when backfill fills vectors left out of a text-only sync", async () => {
    const drive = new MemoryDrive();
    await put(drive, "a", "plain notes");
    const { database, fullReads } = countingDatabase();
    const search = new SearchService({ drive, embedder, database });
    await search.sync();
    await search.warm();

    await put(drive, "b", "kiwi orchard");
    await search.sync({ embed: false });
    const filled = await search.backfillVectors();
    expect(filled.embedded).toBeGreaterThan(0);
    const found = await search.query({ query: "kiwi", limit: 1, remote: false });
    expect(found.searchMode).toBe("semantic");
    expect(found.results[0]?.conversationId).toBe("b");
    expect(fullReads()).toBe(1);
  });

  it("drops a removed document from the cache", async () => {
    const drive = new MemoryDrive();
    await put(drive, "a", "plain notes");
    await put(drive, "b", "kiwi orchard");
    const { database } = countingDatabase();
    const search = new SearchService({ drive, embedder, database });
    await search.sync();
    await search.warm();
    const id = drive.list({ prefix: "inbox/" }).find((entry) => entry.path.endsWith("b.md"))!.id;
    drive.trash(id);
    await search.sync();
    const found = await search.query({ query: "kiwi", limit: 5, remote: false });
    expect(found.results.map((hit) => hit.conversationId)).not.toContain("b");
  });
});
