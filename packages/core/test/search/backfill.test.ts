import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { Embedder } from "../../src/search/embedder.js";
import type { SearchDrive } from "../../src/search/drive.js";
import { BACKFILL_CHUNK_BATCH, SearchService } from "../../src/search/search-service.js";
import { MemoryDrive } from "./memory-drive.js";

function openDatabase(): Database {
  return new Database(":memory:");
}

function markdown(input: {
  conversationId: string;
  updatedAt: string;
  text: string;
}): Uint8Array {
  return new TextEncoder().encode(`---
source: codex
conversation_id: ${input.conversationId}
started_at: 2026-07-18T01:00:00.000Z
updated_at: ${input.updatedAt}
content_sha256: ${"a".repeat(64)}
---
## User
${input.text}
`);
}

function manifestValue(database: Database, key: string): string | null {
  const row = database
    .prepare("SELECT value FROM manifest WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

function vectorCount(database: Database): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM search_vectors").get() as {
    count: number;
  };
  return row.count;
}

function countingDrive(inner: MemoryDrive): { drive: SearchDrive; reads: string[] } {
  const reads: string[] = [];
  const drive: SearchDrive = {
    changes: (query) => inner.changes(query),
    async read(id) {
      reads.push(id);
      return inner.read(id);
    },
  };
  return { drive, reads };
}

function fastEmbedder(onPassages?: (texts: string[]) => void): Embedder & { passages: number } {
  const embedder = {
    model: "backfill-test",
    revision: "v1",
    dimensions: 3,
    passages: 0,
    embedQuery(): Promise<number[]> {
      return Promise.resolve([1, 0, 0]);
    },
    embedPassages(texts: string[]): Promise<number[][]> {
      embedder.passages += 1;
      onPassages?.(texts);
      return Promise.resolve(texts.map(() => [1, 0, 0]));
    },
  };
  return embedder;
}

describe("vector backfill", () => {
  it("indexes full text without embedding and serves keyword search", async () => {
    const drive = new MemoryDrive();
    for (let index = 0; index < 20; index += 1) {
      const name = String(index).padStart(2, "0");
      await drive.put({
        path: `inbox/mac/${name}.md`,
        bytes: markdown({
          conversationId: `conv-${name}`,
          updatedAt: "2026-07-18T02:00:00.000Z",
          text: index === 7 ? "zephyr rollback note" : `plain note ${name}`,
        }),
        mimeType: "text/markdown",
      });
    }
    const embedder = fastEmbedder();
    const database = openDatabase();
    const service = new SearchService({ drive, embedder, database });

    const synced = await service.sync({ embed: false });

    expect(embedder.passages).toBe(0);
    expect(synced).toMatchObject({ done: true, documents: 20, warnings: [] });
    expect(service.status()).toMatchObject({ ready: true, documents: 20 });
    expect(vectorCount(database)).toBe(0);
    expect(manifestValue(database, "vector_mode")).toBe("backfill");
    const found = await service.query({ query: "zephyr", limit: 5 });
    expect(found.searchMode).toBe("keyword");
    expect(found.results.map((result) => result.conversationId)).toEqual(["conv-07"]);
  });

  it("does not rebuild a backfill index for missing vectors, but does when the fingerprint changes", async () => {
    const memory = new MemoryDrive();
    for (let index = 0; index < 3; index += 1) {
      const name = String(index).padStart(2, "0");
      await memory.put({
        path: `inbox/mac/${name}.md`,
        bytes: markdown({
          conversationId: `conv-${name}`,
          updatedAt: "2026-07-18T02:00:00.000Z",
          text: `note ${name}`,
        }),
        mimeType: "text/markdown",
      });
    }
    const watched = countingDrive(memory);
    const embedder = fastEmbedder();
    const database = openDatabase();
    const service = new SearchService({
      drive: watched.drive,
      embedder,
      database,
    });

    await service.sync({ embed: false });
    expect(manifestValue(database, "vector_mode")).toBe("backfill");
    expect(vectorCount(database)).toBe(0);
    const indexedReads = watched.reads.length;
    expect(indexedReads).toBe(3);

    watched.reads.length = 0;
    await service.sync();
    expect(watched.reads).toHaveLength(0);
    expect(embedder.passages).toBe(0);
    expect(vectorCount(database)).toBe(0);

    const rebuilt = new SearchService({
      drive: watched.drive,
      embedder,
      database,
      chunkTokens: 320,
    });
    await rebuilt.sync();
    expect(watched.reads).toHaveLength(3);
  });

  it("backfills missing vectors newest-first and only within the time budget", async () => {
    const count = BACKFILL_CHUNK_BATCH + 2;
    const drive = new MemoryDrive();
    for (let index = 1; index <= count; index += 1) {
      const name = String(index).padStart(2, "0");
      await drive.put({
        path: `inbox/mac/${name}.md`,
        bytes: markdown({
          conversationId: `conv-${name}`,
          updatedAt: `2026-07-${name}T00:00:00.000Z`,
          text: `token-${name} rollback`,
        }),
        mimeType: "text/markdown",
      });
    }
    const seen: string[][] = [];
    const embedder: Embedder = {
      model: "ordered",
      revision: "v1",
      dimensions: 3,
      embedQuery: () => Promise.resolve([1, 0, 0]),
      async embedPassages(texts) {
        seen.push([...texts]);
        await new Promise((resolve) => {
          setTimeout(resolve, 80);
        });
        return texts.map(() => [1, 0, 0]);
      },
    };
    const database = openDatabase();
    const service = new SearchService({
      drive,
      embedder,
      database,
      chunkTokens: 10_000,
      chunkOverlap: 0,
    });
    await service.sync({ embed: false });
    const chunks = database.prepare("SELECT COUNT(*) AS count FROM search_chunks").get() as {
      count: number;
    };
    expect(chunks.count).toBe(count);

    const first = await service.backfillVectors({ budgetMs: 30 });
    expect(seen).toHaveLength(1);
    expect(first.embedded).toBe(BACKFILL_CHUNK_BATCH);
    expect(first.remaining).toBe(2);
    expect(first.warnings).toEqual([]);
    const batch = seen[0] ?? [];
    expect(batch[0]).toContain("token-10");
    for (const day of [10, 9, 8, 7, 6, 5, 4, 3]) {
      expect(batch.some((text) => text.includes(`token-${String(day).padStart(2, "0")}`))).toBe(
        true,
      );
    }
    expect(batch.some((text) => text.includes("token-01") || text.includes("token-02"))).toBe(
      false,
    );

    let remaining = first.remaining;
    while (remaining > 0) {
      const next = await service.backfillVectors({ budgetMs: 30 });
      expect(next.embedded).toBeGreaterThan(0);
      expect(next.remaining).toBeLessThan(remaining);
      remaining = next.remaining;
    }
    expect(vectorCount(database)).toBe(count);
    const ranked = await service.query({ query: "rollback", limit: 5 });
    expect(ranked.searchMode).toBe("semantic");
  });

  it("treats a stuck embedder as unavailable until the retry window passes", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/stuck.md",
      bytes: markdown({
        conversationId: "stuck",
        updatedAt: "2026-07-18T02:00:00.000Z",
        text: "rollback while the model hangs",
      }),
      mimeType: "text/markdown",
    });
    let passages = 0;
    const embedder: Embedder = {
      model: "stuck",
      revision: "v1",
      dimensions: 3,
      embedQuery: () => new Promise<number[]>(() => undefined),
      embedPassages: () => {
        passages += 1;
        return new Promise<number[][]>(() => undefined);
      },
    };
    const database = openDatabase();
    const service = new SearchService({
      drive,
      embedder,
      database,
      embedCallTimeoutMs: 50,
    });
    await service.sync({ embed: false });

    const started = Date.now();
    const stalled = await service.backfillVectors({ budgetMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(passages).toBe(1);
    expect(stalled.embedded).toBe(0);
    expect(stalled.remaining).toBeGreaterThan(0);
    expect(stalled.warnings.map((warning) => warning.code)).toEqual([
      "MODEL_UNAVAILABLE_KEYWORD_FALLBACK",
    ]);
    expect(Number(manifestValue(database, "vector_retry_after"))).toBeGreaterThan(
      Date.now() + 60 * 60 * 1000,
    );

    const skipped = await service.backfillVectors({ budgetMs: 10_000 });
    expect(passages).toBe(1);
    expect(skipped.embedded).toBe(0);
    expect(skipped.remaining).toBe(stalled.remaining);
    expect(skipped.warnings).toEqual([]);
  }, 3_000);

  it("resumes an existing pending_sync without rereading finished documents", async () => {
    const memory = new MemoryDrive();
    for (let index = 0; index < 5; index += 1) {
      const name = String(index).padStart(2, "0");
      await memory.put({
        path: `inbox/mac/${name}.md`,
        bytes: markdown({
          conversationId: `conv-${name}`,
          updatedAt: "2026-07-18T02:00:00.000Z",
          text: `note-${name} rollback`,
        }),
        mimeType: "text/markdown",
      });
    }
    const entries = memory.list({ prefix: "inbox/" });
    expect(entries).toHaveLength(5);
    const watched = countingDrive(memory);
    let passages = 0;
    const embedder: Embedder = {
      model: "resume-model",
      revision: "v9",
      dimensions: 3,
      embedQuery: () => Promise.resolve([1, 0, 0]),
      embedPassages: (texts) => {
        passages += 1;
        return Promise.resolve(texts.map(() => [1, 0, 0]));
      },
    };
    const database = openDatabase();
    const service = new SearchService({
      drive: watched.drive,
      embedder,
      database,
    });
    const insert = database.prepare(
      `INSERT INTO search_chunks(
         drive_file_id, drive_path, source, conversation_id,
         started_at, updated_at, content_sha256, chunk_id, text
       ) VALUES (?, ?, 'codex', ?, '2026-07-18T01:00:00.000Z', '2026-07-18T02:00:00.000Z', ?, 'chunk-1', ?)`,
    );
    for (const entry of entries.slice(0, 2)) {
      insert.run(entry.id, entry.path, entry.id, "b".repeat(64), `already-indexed-${entry.id}`);
    }
    const pending = {
      fingerprint: JSON.stringify({
        model: "resume-model",
        revision: "v9",
        dimensions: 3,
        chunkTokens: 448,
        chunkOverlap: 64,
      }),
      reset: true,
      removed: [] as string[],
      cursor: "saved-cursor",
      entries,
    };
    database
      .prepare(
        `INSERT INTO manifest(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("pending_sync", JSON.stringify(pending));
    database
      .prepare(
        `INSERT INTO manifest(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("pending_done", "2");

    const synced = await service.sync({ embed: false });

    expect(passages).toBe(0);
    expect(synced).toMatchObject({ done: true, documents: 5 });
    expect(service.status()).toMatchObject({ ready: true, documents: 5 });
    expect(manifestValue(database, "pending_sync")).toBeNull();
    expect(manifestValue(database, "pending_done")).toBeNull();
    expect(watched.reads.slice().sort()).toEqual(entries.slice(2).map((entry) => entry.id).sort());
    for (const entry of entries.slice(0, 2)) {
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count, MIN(text) AS text FROM search_chunks WHERE drive_file_id = ?",
        )
        .get(entry.id) as { count: number; text: string };
      expect(row).toEqual({ count: 1, text: `already-indexed-${entry.id}` });
    }
    const found = await service.query({ query: "note-04", limit: 5 });
    expect(found.results.map((result) => result.conversationId)).toContain("conv-04");
    expect(vectorCount(database)).toBe(0);
  });

  it("does not embed on the query path", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/query.md",
      bytes: markdown({
        conversationId: "query-path",
        updatedAt: "2026-07-18T02:00:00.000Z",
        text: "zephyr on the query path",
      }),
      mimeType: "text/markdown",
    });
    const embedder = fastEmbedder();
    const service = new SearchService({
      drive,
      embedder,
      database: openDatabase(),
    });

    const result = await service.search({ query: "zephyr", limit: 5 });

    expect(embedder.passages).toBe(0);
    expect(result.searchMode).toBe("keyword");
    expect(result.indexStatus).toBe("fresh");
    expect(result.results.map((hit) => hit.conversationId)).toEqual(["query-path"]);
  });

  it("reports no remaining vectors when semantic search is off or there is no embedder", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/off.md",
      bytes: markdown({
        conversationId: "off",
        updatedAt: "2026-07-18T02:00:00.000Z",
        text: "rollback with semantic search off",
      }),
      mimeType: "text/markdown",
    });
    const embedder = fastEmbedder();
    const off = new SearchService({
      drive,
      embedder,
      database: openDatabase(),
      semantic: false,
    });
    await off.sync({ embed: false });
    expect(await off.backfillVectors({ budgetMs: 1_000 })).toEqual({
      embedded: 0,
      remaining: 0,
      warnings: [],
    });
    expect(embedder.passages).toBe(0);

    const missing = new SearchService({
      drive,
      embedder: null,
      database: openDatabase(),
    });
    await missing.sync({ embed: false });
    expect(await missing.backfillVectors({ budgetMs: 1_000 })).toEqual({
      embedded: 0,
      remaining: 0,
      warnings: [],
    });
  });
});
