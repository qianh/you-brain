import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { Embedder } from "../../src/search/embedder.js";
import { SearchService } from "../../src/search/search-service.js";
import { MemoryDrive } from "./memory-drive.js";

/** Records every embedded text, to tell which chunks were embedded again. */
function countingEmbedder(model = "fast"): Embedder & { embedded: string[] } {
  const embedded: string[] = [];
  return {
    model,
    revision: "v1",
    dimensions: 3,
    embedded,
    embedQuery: () => Promise.resolve([1, 0, 0]),
    embedPassages: (texts) => {
      embedded.push(...texts);
      return Promise.resolve(texts.map(() => [1, 0, 0]));
    },
  };
}

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

const words = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");

async function put(drive: MemoryDrive, name: string, body: string) {
  return drive.upsert({ path: `inbox/mac/${name}.md`, bytes: markdown(name, body), mimeType: "text/markdown" });
}

function service(drive: MemoryDrive, database: Database, embedder: Embedder): SearchService {
  // Small chunks, so one document spans several.
  return new SearchService({ drive, embedder, database, chunkTokens: 16, chunkOverlap: 0 });
}

function vectorless(database: Database): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count FROM search_chunks c
    LEFT JOIN search_vectors v ON v.drive_file_id = c.drive_file_id AND v.chunk_id = c.chunk_id
    WHERE v.chunk_id IS NULL
  `).get() as { count: number }).count;
}

describe("rebuild after an expired Drive cursor (410)", () => {
  it("downloads and embeds only changed files, drops deleted ones, keeps the rest", async () => {
    const drive = new MemoryDrive();
    const kept = await put(drive, "kept", words("keep", 40));
    const edited = await put(drive, "edited", words("old", 40));
    const gone = await put(drive, "gone", words("gone", 40));
    const database = new Database(":memory:");
    const embedder = countingEmbedder();
    const search = service(drive, database, embedder);
    await search.sync();
    expect(search.status().documents).toBe(3);

    await put(drive, "edited", words("new", 40));
    drive.trash(gone.id);
    const added = await put(drive, "added", words("add", 40));
    drive.expireCursor();
    drive.reads.length = 0;
    embedder.embedded.length = 0;

    const result = await search.sync();
    expect(result.done).toBe(true);
    expect(drive.reads.sort()).toEqual([edited.id, added.id].sort());
    expect(embedder.embedded.some((text) => text.includes("keep"))).toBe(false);
    expect(embedder.embedded.some((text) => text.includes("new0"))).toBe(true);
    expect(search.status()).toMatchObject({ ready: true, documents: 3 });
    const files = (database.prepare("SELECT DISTINCT drive_file_id AS id FROM search_chunks").all() as Array<{ id: string }>)
      .map((row) => row.id)
      .sort();
    expect(files).toEqual([kept.id, edited.id, added.id].sort());
    expect(vectorless(database)).toBe(0);
    const hits = await search.search({ query: "new3", limit: 5 });
    expect(hits.results.some((hit) => hit.conversationId === "edited" && hit.excerpt.includes("new3"))).toBe(true);
  });

  it("keeps the index while a multi-pass rebuild runs and reports progress", async () => {
    const drive = new MemoryDrive();
    for (let index = 0; index < 25; index += 1) await put(drive, `n${index}`, words(`w${index}x`, 20));
    const database = new Database(":memory:");
    const search = service(drive, database, countingEmbedder());
    await search.sync();
    for (let index = 0; index < 25; index += 1) await put(drive, `n${index}`, words(`v${index}x`, 20));
    drive.expireCursor();

    const first = await search.sync({ budgetMs: 0 });
    expect(first.done).toBe(false);
    // The first batch used to clear the index, dropping to 10 documents. It now stays at 25.
    expect(search.status()).toMatchObject({ ready: false, documents: 25, progress: { done: 10, total: 25 } });
    while (!(await search.sync({ budgetMs: 0 })).done) { /* keep going */ }
    expect(search.status()).toEqual(expect.objectContaining({ ready: true, documents: 25 }));
    expect(search.status().progress).toBeUndefined();
  });
});

describe("vector reuse", () => {
  it("embeds only the new chunks when a session file grows", async () => {
    const drive = new MemoryDrive();
    await put(drive, "chat", words("first", 48));
    const database = new Database(":memory:");
    const embedder = countingEmbedder();
    const search = service(drive, database, embedder);
    await search.sync();
    const before = embedder.embedded.length;
    expect(before).toBeGreaterThan(2);

    embedder.embedded.length = 0;
    await put(drive, "chat", `${words("first", 48)} ${words("later", 16)}`);
    await search.sync();
    expect(embedder.embedded.length).toBeGreaterThan(0);
    expect(embedder.embedded.length).toBeLessThan(before);
    expect(embedder.embedded.every((text) => !text.startsWith("---"))).toBe(true);
    expect(vectorless(database)).toBe(0);
  });

  it("carries old vectors for unchanged chunks even when vectors are left to backfill", async () => {
    const drive = new MemoryDrive();
    await put(drive, "chat", words("first", 48));
    const database = new Database(":memory:");
    const search = service(drive, database, countingEmbedder());
    await search.sync();
    await put(drive, "chat", `${words("first", 48)} ${words("later", 16)}`);
    await search.sync({ embed: false });
    const total = (database.prepare("SELECT COUNT(*) AS count FROM search_chunks").get() as { count: number }).count;
    const holes = vectorless(database);
    expect(holes).toBeGreaterThan(0);
    expect(holes).toBeLessThan(total);
  });

  it("rebuilds from scratch without reuse when the model changes", async () => {
    const drive = new MemoryDrive();
    await put(drive, "chat", words("first", 48));
    const database = new Database(":memory:");
    await service(drive, database, countingEmbedder("old-model")).sync();

    const next = countingEmbedder("new-model");
    const search = service(drive, database, next);
    await search.sync();
    const total = (database.prepare("SELECT COUNT(*) AS count FROM search_chunks").get() as { count: number }).count;
    expect(next.embedded.length).toBe(total);
  });
});
