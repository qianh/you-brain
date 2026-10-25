import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import type { Embedder } from "../../src/search/embedder.js";
import type { SearchDrive, SearchDriveEntry } from "../../src/search/drive.js";
import { SEARCH_DRIVE_CURSOR } from "../../src/search/schema.js";
import { SearchService } from "../../src/search/search-service.js";
import { MemoryDrive } from "./memory-drive.js";

const embedder: Embedder = {
  model: "fast",
  revision: "v1",
  dimensions: 3,
  embedQuery: () => Promise.resolve([1, 0, 0]),
  embedPassages: (texts) => Promise.resolve(texts.map(() => [1, 0, 0])),
};

function openDatabase(): Database {
  return new Database(":memory:");
}

function markdown(conversationId: string, text: string): Uint8Array {
  return new TextEncoder().encode(`---
source: codex
conversation_id: ${conversationId}
started_at: 2026-07-18T01:00:00.000Z
updated_at: 2026-07-18T02:00:00.000Z
content_sha256: ${"a".repeat(64)}
---
## User
${text}
`);
}

async function putDocs(drive: MemoryDrive, count: number, start = 0): Promise<void> {
  for (let index = start; index < start + count; index += 1) {
    const name = String(index).padStart(2, "0");
    await drive.put({
      path: `inbox/mac/${name}.md`,
      bytes: markdown(`conv-${name}`, `note ${name} rollback`),
      mimeType: "text/markdown",
    });
  }
}

function manifestValue(database: Database, key: string): string | null {
  const row = database
    .prepare("SELECT value FROM manifest WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

function driveCursor(database: Database): string | null {
  const row = database
    .prepare("SELECT value FROM cursors WHERE key = ?")
    .get(SEARCH_DRIVE_CURSOR) as { value: string } | null;
  return row?.value ?? null;
}

function chunksFor(database: Database, id: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE drive_file_id = ?")
    .get(id) as { count: number };
  return row.count;
}

interface ChunkStats {
  total: number;
  distinct_rows: number;
  documents: number;
}

function chunkStats(database: Database): ChunkStats {
  return database
    .prepare(
      `
      SELECT COUNT(*) AS total,
             COUNT(DISTINCT drive_file_id || ':' || chunk_id) AS distinct_rows,
             COUNT(DISTINCT drive_file_id) AS documents
      FROM search_chunks
    `,
    )
    .get() as ChunkStats;
}

function insertChunk(database: Database, id: string): void {
  database
    .prepare(
      `INSERT INTO search_chunks(
         drive_file_id, drive_path, source, conversation_id,
         started_at, updated_at, content_sha256, chunk_id, text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      `inbox/mac/${id}.md`,
      "codex",
      id,
      "2026-07-18T01:00:00.000Z",
      "2026-07-18T02:00:00.000Z",
      "b".repeat(64),
      "chunk-1",
      `text ${id}`,
    );
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

class ScriptedDrive implements SearchDrive {
  entries: SearchDriveEntry[] = [];
  removedIds: string[] = [];
  cursor = "1";
  reset = true;
  readonly files = new Map<string, Uint8Array>();

  async changes(): Promise<{
    entries: SearchDriveEntry[];
    removedIds: string[];
    cursor: string;
    reset: boolean;
  }> {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      removedIds: [...this.removedIds],
      cursor: this.cursor,
      reset: this.reset,
    };
  }

  async read(id: string): Promise<{ bytes: Uint8Array }> {
    const bytes = this.files.get(id);
    if (!bytes) throw new Error(`Drive object not found: ${id}`);
    return { bytes: new Uint8Array(bytes) };
  }
}

function stagedFile(drive: ScriptedDrive, id: string, text: string): SearchDriveEntry {
  drive.files.set(id, markdown(id, text));
  return { id, path: `inbox/mac/${id}.md`, mimeType: "text/markdown" };
}

const modelCases: Array<{ label: string; embedder: Embedder | null }> = [
  {
    label: "a throwing embedder",
    embedder: {
      model: "down",
      revision: "v1",
      dimensions: 3,
      embedQuery: () => Promise.reject(new Error("model unavailable")),
      embedPassages: () => Promise.reject(new Error("model unavailable")),
    },
  },
  { label: "no embedder", embedder: null },
];

describe("batched search sync", () => {
  it("commits ten documents per zero-budget pass and publishes the cursor only when finished", async () => {
    const memory = new MemoryDrive();
    await putDocs(memory, 25);
    const database = openDatabase();
    const service = new SearchService({ drive: memory, embedder, database });

    expect(await service.sync({ budgetMs: 0 })).toMatchObject({ done: false, documents: 10 });
    expect(driveCursor(database)).toBeNull();
    expect(manifestValue(database, "pending_done")).toBe("10");
    expect(service.status()).toEqual({ ready: false, documents: 10 });

    expect(await service.sync({ budgetMs: 0 })).toMatchObject({ done: false, documents: 20 });
    expect(driveCursor(database)).toBeNull();
    expect(manifestValue(database, "pending_done")).toBe("20");

    const finished = await service.sync({ budgetMs: 0 });
    const cursor = driveCursor(database);
    expect(finished).toMatchObject({ done: true, documents: 25 });
    expect(cursor).not.toBeNull();
    expect(manifestValue(database, "pending_sync")).toBeNull();
    expect(manifestValue(database, "pending_done")).toBeNull();
    expect(service.status().ready).toBe(true);
    expect(service.status().documents).toBe(25);

    await putDocs(memory, 15, 25);
    const partial = await service.sync({ budgetMs: 0 });
    expect(partial).toMatchObject({ done: false, documents: 35 });
    expect(driveCursor(database)).toBe(cursor);
    expect(service.status()).toMatchObject({ ready: false, documents: 35 });
  });

  it("resumes a discarded service from pending_done without duplicating chunks", async () => {
    const memory = new MemoryDrive();
    await putDocs(memory, 25);
    const watched = countingDrive(memory);
    const database = openDatabase();
    const first = new SearchService({
      drive: watched.drive,
      embedder,
      database,
    });

    await first.sync({ budgetMs: 0 });
    const firstReads = [...watched.reads];
    const perFile = chunkStats(database).total / 10;
    expect(firstReads).toHaveLength(10);
    expect(Number.isInteger(perFile)).toBe(true);
    expect(perFile).toBeGreaterThan(0);

    watched.reads.length = 0;
    const second = new SearchService({
      drive: watched.drive,
      embedder,
      database,
    });
    const mid = await second.sync({ budgetMs: 0 });
    expect(mid).toMatchObject({ done: false, documents: 20 });
    expect(watched.reads).toHaveLength(10);
    expect(watched.reads.every((id) => !firstReads.includes(id))).toBe(true);

    const done = await second.sync({ budgetMs: 0 });
    const stats = chunkStats(database);
    expect(done).toMatchObject({ done: true, documents: 25 });
    expect(stats.documents).toBe(25);
    expect(stats.total).toBe(25 * perFile);
    expect(stats.total).toBe(stats.distinct_rows);
    expect(driveCursor(database)).not.toBeNull();
  });

  it.each(modelCases)(
    "does not rebuild a vectorless index until vector_retry_after passes ($label)",
    async ({ embedder: model }) => {
      const memory = new MemoryDrive();
      await putDocs(memory, 3);
      const watched = countingDrive(memory);
      const database = openDatabase();
      const service = new SearchService({
        drive: watched.drive,
        embedder: model,
        database,
        semantic: true,
      });

      const first = await service.sync();
      expect(first).toMatchObject({ done: true, documents: 3 });
      expect(first.warnings.map((warning) => warning.code)).toContain(
        "MODEL_UNAVAILABLE_KEYWORD_FALLBACK",
      );
      expect(watched.reads).toHaveLength(3);
      expect(Number(manifestValue(database, "vector_retry_after"))).toBeGreaterThan(Date.now());

      await service.sync();
      await service.sync();
      expect(watched.reads).toHaveLength(3);
      expect(Number(manifestValue(database, "vector_retry_after"))).toBeGreaterThan(Date.now());
      expect(chunkStats(database).documents).toBe(3);

      database
        .prepare("UPDATE manifest SET value = ? WHERE key = ?")
        .run("0", "vector_retry_after");
      await service.sync();
      expect(watched.reads).toHaveLength(6);
      expect(chunkStats(database).documents).toBe(3);
    },
  );

  it("applies removals on the first batch and clears a reset only once", async () => {
    const removed = openDatabase();
    const listing = new ScriptedDrive();
    const keep = stagedFile(listing, "keep", "keep this note");
    const gone = stagedFile(listing, "gone", "delete this note");
    listing.entries = [keep, gone];
    listing.cursor = "1";
    listing.reset = true;
    const removal = new SearchService({ drive: listing, embedder, database: removed });
    insertChunk(removed, "junk");
    await removal.sync();
    expect(chunksFor(removed, "junk")).toBe(0);
    expect(chunksFor(removed, "keep")).toBeGreaterThan(0);
    expect(chunksFor(removed, "gone")).toBeGreaterThan(0);
    expect(driveCursor(removed)).toBe("1");

    listing.entries = Array.from({ length: 25 }, (_, index) =>
      stagedFile(listing, `n${String(index).padStart(2, "0")}`, `new ${index}`),
    );
    listing.removedIds = ["gone"];
    listing.reset = false;
    listing.cursor = "2";
    const firstRemoved = await removal.sync({ budgetMs: 0 });
    expect(firstRemoved).toMatchObject({ done: false, documents: 11 });
    expect(chunksFor(removed, "gone")).toBe(0);
    expect(chunksFor(removed, "keep")).toBeGreaterThan(0);
    expect(chunksFor(removed, "n00")).toBeGreaterThan(0);
    expect(driveCursor(removed)).toBe("1");

    insertChunk(removed, "sentinel");
    const secondRemoved = await removal.sync({ budgetMs: 0 });
    expect(secondRemoved.documents).toBe(22);
    expect(chunksFor(removed, "sentinel")).toBe(1);
    expect(chunksFor(removed, "keep")).toBeGreaterThan(0);
    expect(chunksFor(removed, "n00")).toBeGreaterThan(0);
    expect(chunksFor(removed, "n10")).toBeGreaterThan(0);
    expect(chunksFor(removed, "gone")).toBe(0);
    expect(driveCursor(removed)).toBe("1");

    const rebuilt = openDatabase();
    const full = new ScriptedDrive();
    full.entries = Array.from({ length: 25 }, (_, index) =>
      stagedFile(full, `r${String(index).padStart(2, "0")}`, `reset ${index}`),
    );
    full.reset = true;
    full.cursor = "9";
    const resetting = new SearchService({ drive: full, embedder, database: rebuilt });
    insertChunk(rebuilt, "junk");
    const cleared = await resetting.sync({ budgetMs: 0 });
    expect(cleared.documents).toBe(10);
    expect(chunksFor(rebuilt, "junk")).toBe(0);
    expect(chunksFor(rebuilt, "r00")).toBeGreaterThan(0);
    insertChunk(rebuilt, "sentinel");
    const continued = await resetting.sync({ budgetMs: 0 });
    expect(continued.documents).toBe(21);
    expect(chunksFor(rebuilt, "sentinel")).toBe(1);
    expect(chunksFor(rebuilt, "r00")).toBeGreaterThan(0);
    expect(chunksFor(rebuilt, "r10")).toBeGreaterThan(0);
    expect(driveCursor(rebuilt)).toBeNull();
  });

  it("returns a stale search hit within the query budget while files remain", async () => {
    const memory = new MemoryDrive();
    await putDocs(memory, 25);
    let reads = 0;
    let wave: Promise<void> | undefined;
    const drive: SearchDrive = {
      changes: (query) => memory.changes(query),
      async read(id) {
        reads += 1;
        wave ??= new Promise((resolve) => {
          setTimeout(resolve, 3_500);
        });
        await wave;
        return memory.read(id);
      },
    };
    const service = new SearchService({
      drive,
      embedder,
      database: openDatabase(),
    });

    const result = await service.search({ query: "rollback", limit: 5 });

    expect(result.indexStatus).toBe("stale");
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "INDEX_STALE",
      "MODEL_UNAVAILABLE_KEYWORD_FALLBACK",
    ]);
    expect(result.results.length).toBeGreaterThan(0);
    expect(reads).toBe(10);
    expect(service.status()).toMatchObject({ ready: false, documents: 10 });
  }, 15_000);

  it("retries a batch whose read failed instead of skipping the file", async () => {
    const memory = new MemoryDrive();
    await putDocs(memory, 25);
    const order = memory.list({ prefix: "inbox/" });
    const failing = order[10];
    if (!failing) throw new Error("missing fixture file");
    let fail = true;
    const reads: string[] = [];
    const drive: SearchDrive = {
      changes: (query) => memory.changes(query),
      async read(id) {
        if (fail && id === failing.id) throw new Error("read failed");
        reads.push(id);
        return memory.read(id);
      },
    };
    const database = openDatabase();
    const service = new SearchService({ drive, embedder, database });

    await service.sync({ budgetMs: 0 });
    expect(service.status().documents).toBe(10);
    await expect(service.sync({ budgetMs: 0 })).rejects.toThrow("read failed");
    expect(service.status().documents).toBe(10);
    expect(manifestValue(database, "pending_done")).toBe("10");
    expect(driveCursor(database)).toBeNull();

    fail = false;
    const resumed = await service.sync({ budgetMs: 0 });
    expect(resumed).toMatchObject({ done: false, documents: 20 });
    expect(reads).toContain(failing.id);
  });
});
