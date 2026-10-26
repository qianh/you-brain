import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";

import { chunkText } from "./chunk-text.js";
import type { SearchDrive, SearchDriveEntry } from "./drive.js";
import { deviceOfInboxPath, excerptAround, queryTerms } from "./remote.js";
import { inScope } from "./scope.js";
import {
  E5_SMALL,
  EMBED_MAX_CHARS,
  EMBED_PASSAGE_BATCH,
  clampEmbedText,
  splitEmbedBatches,
  type Embedder,
} from "./embedder.js";
import { isInboxSessionFile } from "../drive/inbox-file.js";
import { chunkKey, indexBody, keywordScores } from "./fts.js";
import { redactText, type RedactionOptions } from "./redact.js";
import { ensureSearchSchema, SEARCH_DRIVE_CURSOR } from "./schema.js";
import { parseSearchRange, updatedAtInRange } from "./time-range.js";

interface Frontmatter {
  source: string;
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  contentSha256: string;
}

interface IndexedChunk {
  driveFileId: string;
  drivePath: string;
  source: string;
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  contentSha256: string;
  chunkId: string;
  text: string;
  vector: number[] | null;
}

interface ChunkRow {
  drive_file_id: string;
  drive_path: string;
  source: string;
  conversation_id: string;
  started_at: string;
  updated_at: string;
  content_sha256: string;
  chunk_id: string;
  text: string;
  vector: Uint8Array | null;
}

interface CountRow {
  count: number;
}

interface MetadataRow {
  key: string;
  value: string;
}

export interface SearchOutput {
  query: string;
  indexStatus: "fresh" | "stale";
  searchMode: "semantic" | "keyword";
  results: Array<{
    score: number;
    source: string;
    conversationId: string;
    startedAt: string;
    updatedAt: string;
    excerpt: string;
    /** Set for a hit found on Drive in another device's folder. */
    device?: string;
    driveFileId?: string;
  }>;
  warnings: Array<{ code: string; message: string }>;
}

export interface SearchStatus {
  ready: boolean;
  documents: number;
  cursor?: string;
  generatedAt?: string;
}

/** Documents indexed per committed batch. A pass stops between batches when its budget is spent. */
const SYNC_BATCH_ENTRIES = 10;
/** Chunks embedded per backfill batch. The time budget is checked after each batch. */
export const BACKFILL_CHUNK_BATCH = 8;
/** One embed call must not stall a tick longer than this. A timeout is a missing model. */
const EMBED_CALL_TIMEOUT_MS = 60_000;
/** Without a model, rows stay vectorless. Do not rebuild the index to fill them more often than this. */
const VECTOR_RETRY_MS = 6 * 60 * 60 * 1000;
const PENDING_KEY = "pending_sync";
const PENDING_DONE_KEY = "pending_done";
const VECTOR_RETRY_KEY = "vector_retry_after";
/** `backfill` fills vectors in the background. `eager` may rebuild when vectors are missing. */
const VECTOR_MODE_KEY = "vector_mode";

/** Work found by one Drive listing that is still being indexed. Survives a restart. */
interface PendingSync {
  fingerprint: string;
  /** The whole index is rebuilt: the first committed batch clears it. */
  reset: boolean;
  removed: string[];
  cursor: string;
  entries: SearchDriveEntry[];
}

interface SyncBatch {
  work: PendingSync;
  /** True only for offset 0. A resumed pass must not clear or replay removals. */
  applyListing: boolean;
  batch: SearchDriveEntry[];
  chunks: IndexedChunk[];
  next: number;
  /** False once this pass has fallen back to keywords. */
  modelAvailable: boolean;
  /** False stores chunks and FTS only. Vectors stay empty for a later backfill. */
  embed: boolean;
}

const keywordFallback = {
  code: "MODEL_UNAVAILABLE_KEYWORD_FALLBACK",
  message: "Embedding model is unavailable; using keyword search",
} as const;

const remoteUnavailable = {
  code: "REMOTE_SEARCH_UNAVAILABLE",
  message: "Searching other devices' sessions on Drive failed; showing this device only",
} as const;

/** Hits read from Drive per query; each costs one download. */
const REMOTE_HITS = 10;
const REMOTE_SEARCH_TIMEOUT_MS = 8_000;

const staleIndex = {
  code: "INDEX_STALE",
  message: "Search index refresh failed; using the last local index",
} as const;

function parseFrontmatter(markdown: string): Frontmatter {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  const fields = new Map<string, string>();
  for (const line of match?.[1]?.split("\n") ?? []) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields.set(
        line.slice(0, separator).trim(),
        line.slice(separator + 1).trim(),
      );
    }
  }
  const contentSha256 =
    fields.get("content_sha256") ??
    createHash("sha256").update(markdown).digest("hex");
  return {
    source: fields.get("source") ?? "unknown",
    conversationId: fields.get("conversation_id") ?? contentSha256,
    startedAt: fields.get("started_at") ?? new Date(0).toISOString(),
    updatedAt: fields.get("updated_at") ?? new Date(0).toISOString(),
    contentSha256,
  };
}

function stripImages(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "[image omitted]")
    .replace(/<img\b[^>]*>/giu, "[image omitted]");
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return -1;
    sum += a * b;
  }
  return sum;
}

function encodeVector(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

function decodeVector(blob: Uint8Array): number[] {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return [...new Float32Array(copy.buffer)];
}

function addWarning(
  warnings: SearchOutput["warnings"],
  warning: SearchOutput["warnings"][number],
): void {
  if (!warnings.some(({ code }) => code === warning.code)) {
    warnings.push(warning);
  }
}

function metadataMap(database: Database): Record<string, string> {
  const rows = database
    .prepare("SELECT key, value FROM manifest")
    .all() as MetadataRow[];
  return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
}

export class SearchService {
  readonly #drive: SearchDrive;
  readonly #scope: (() => readonly string[]) | null;
  readonly #embedder: Embedder | null;
  readonly #model: string;
  readonly #revision: string;
  readonly #dimensions: number;
  readonly #semantic: boolean;
  readonly #batchSize: number;
  readonly #maxChars: number;
  readonly #database: Database;
  readonly #chunkTokens: number;
  readonly #chunkOverlap: number;
  readonly #embedCallTimeoutMs: number;
  readonly #redact: (text: string) => string;

  constructor(options: {
    drive: SearchDrive;
    embedder: Embedder | null;
    database: Database;
    /** Default true. False skips the embedder and reports keyword mode without a fallback warning. */
    semantic?: boolean;
    /** Drive path prefixes this device indexes. Unset indexes the whole inbox. Read on every pass. */
    scope?: () => readonly string[];
    embedBatchSize?: number;
    embedMaxChars?: number;
    /** Upper bound for one backfill `embedPassages` call. Default 60s. */
    embedCallTimeoutMs?: number;
    chunkTokens?: number;
    chunkOverlap?: number;
    redact?: (text: string) => string;
    redaction?: RedactionOptions;
  }) {
    this.#drive = options.drive;
    this.#scope = options.scope ?? null;
    this.#embedder = options.embedder;
    this.#model = options.embedder?.model ?? E5_SMALL.model;
    this.#revision = options.embedder?.revision ?? E5_SMALL.revision;
    this.#dimensions = options.embedder?.dimensions ?? E5_SMALL.dimensions;
    this.#semantic = options.semantic !== false;
    this.#batchSize = options.embedBatchSize ?? EMBED_PASSAGE_BATCH;
    this.#maxChars = options.embedMaxChars ?? EMBED_MAX_CHARS;
    this.#database = options.database;
    this.#chunkTokens = options.chunkTokens ?? 448;
    this.#chunkOverlap = options.chunkOverlap ?? 64;
    this.#embedCallTimeoutMs = options.embedCallTimeoutMs ?? EMBED_CALL_TIMEOUT_MS;
    const redaction = options.redaction;
    this.#redact =
      options.redact ??
      (redaction
        ? (text) => redactText(text, redaction).text
        : (text) => redactText(text).text);
    ensureSearchSchema(this.#database);
  }

  #indexFingerprint(): string {
    const fingerprint: Record<string, string | number | boolean> = {
      model: this.#model,
      revision: this.#revision,
      dimensions: this.#dimensions,
      chunkTokens: this.#chunkTokens,
      chunkOverlap: this.#chunkOverlap,
    };
    if (!this.#semantic) fingerprint.semantic = false;
    // A new scope rebuilds the index so documents outside it are dropped.
    if (this.#scope) fingerprint.scope = [...this.#scope()].sort().join("|");
    return JSON.stringify(fingerprint);
  }

  /** True when semantic search is on and a stored chunk has no vector. */
  #missingVector(): boolean {
    if (!this.#semantic) return false;
    const row = this.#database
      .prepare(
        `
        SELECT 1 AS missing
        FROM search_chunks c
        LEFT JOIN search_vectors v
          ON v.drive_file_id = c.drive_file_id AND v.chunk_id = c.chunk_id
        WHERE v.chunk_id IS NULL
        LIMIT 1
      `,
      )
      .get() as { missing: number } | null;
    return row !== null;
  }

  #cursor(): string | undefined {
    const metadata = metadataMap(this.#database);
    if (metadata.index_fingerprint !== this.#indexFingerprint()) return undefined;
    // Backfill fills holes in place. Eager mode still rebuilds once the retry window ends.
    if (metadata[VECTOR_MODE_KEY] !== "backfill") {
      const missingVector = this.#missingVector();
      const retryAfter = Number(metadata[VECTOR_RETRY_KEY] ?? "0");
      const waitingForModel = missingVector && Date.now() < retryAfter;
      if (missingVector && !waitingForModel) return undefined;
    }
    const row = this.#database
      .prepare("SELECT value FROM cursors WHERE key = ?")
      .get(SEARCH_DRIVE_CURSOR) as { value: string } | null;
    return row?.value;
  }

  /**
   * Brings the index up to date with Drive. Work is committed batch by batch and the rest
   * is remembered, so a pass can stop once `budgetMs` is spent and the next one carries on,
   * also after a restart. `done` is false while work remains. Without a budget the pass
   * runs to the end. `embed: false` stores text only and leaves vectors for `backfillVectors`.
   */
  async sync(options: { budgetMs?: number; embed?: boolean } = {}): Promise<{
    documents: number;
    warnings: SearchOutput["warnings"];
    done: boolean;
  }> {
    ensureSearchSchema(this.#database);
    const embed = options.embed !== false;
    const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs;
    const work = this.#readPending() ?? (await this.#findWork());
    let offset = work.offset;
    const warnings: SearchOutput["warnings"] = [];
    let modelAvailable = true;
    do {
      const batch = work.entries.slice(offset, offset + SYNC_BATCH_ENTRIES);
      const indexed = await this.#indexEntries(batch, modelAvailable, embed);
      modelAvailable = indexed.modelAvailable;
      for (const warning of indexed.warnings) addWarning(warnings, warning);
      this.#commit({
        work,
        applyListing: offset === 0,
        batch,
        chunks: indexed.chunks,
        next: offset + batch.length,
        modelAvailable,
        embed,
      });
      offset += batch.length;
    } while (offset < work.entries.length && Date.now() < deadline);
    const count = this.#database
      .prepare("SELECT COUNT(DISTINCT drive_file_id) AS count FROM search_chunks")
      .get() as CountRow;
    return { documents: count.count, warnings, done: offset >= work.entries.length };
  }

  /** Lists what changed in Drive and remembers it as the work to do. */
  async #findWork(): Promise<PendingSync & { offset: number }> {
    const cursor = this.#cursor();
    const changes = await this.#drive.changes(
      cursor === undefined ? { prefix: "inbox/" } : { prefix: "inbox/", cursor },
    );
    const prefixes = this.#scope?.() ?? null;
    const entries = changes.entries.filter(
      (entry) =>
        (prefixes === null || inScope(entry.path, prefixes)) && isInboxSessionFile(entry),
    );
    const removedIds = new Set(changes.removedIds);
    for (const entry of changes.entries) {
      if (!entries.includes(entry)) removedIds.add(entry.id);
    }
    const work: PendingSync = {
      fingerprint: this.#indexFingerprint(),
      reset: changes.reset,
      removed: [...removedIds],
      cursor: changes.cursor,
      entries,
    };
    if (entries.length > SYNC_BATCH_ENTRIES) {
      // Only a pass that may stop early needs to survive a restart.
      this.#database
        .prepare(
          `INSERT INTO manifest(key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(PENDING_KEY, JSON.stringify(work));
      this.#setManifest(PENDING_DONE_KEY, "0");
    }
    return { ...work, offset: 0 };
  }

  #readPending(): (PendingSync & { offset: number }) | null {
    const metadata = metadataMap(this.#database);
    const raw = metadata[PENDING_KEY];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PendingSync;
      if (parsed.fingerprint !== this.#indexFingerprint()) {
        this.#clearPending();
        return null;
      }
      return { ...parsed, offset: Number(metadata[PENDING_DONE_KEY] ?? "0") || 0 };
    } catch {
      this.#clearPending();
      return null;
    }
  }

  #setManifest(key: string, value: string): void {
    this.#database
      .prepare(
        `INSERT INTO manifest(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  #clearPending(): void {
    this.#database.prepare("DELETE FROM manifest WHERE key IN (?, ?)").run(PENDING_KEY, PENDING_DONE_KEY);
  }

  async #indexEntries(
    entries: SearchDriveEntry[],
    modelAvailable: boolean,
    embed: boolean,
  ): Promise<{
    chunks: IndexedChunk[];
    warnings: SearchOutput["warnings"];
    modelAvailable: boolean;
  }> {
    const warnings: SearchOutput["warnings"] = [];
    // Reads run together. A failure rejects the whole batch so it is not committed
    // and the next pass retries the same files.
    const loaded = await Promise.all(
      entries.map(async (entry) => {
        const sourceObject = await this.#drive.read(entry.id);
        return {
          entry,
          markdown: new TextDecoder().decode(sourceObject.bytes),
        };
      }),
    );
    const chunks: IndexedChunk[] = [];
    let available = modelAvailable;
    for (const { entry, markdown } of loaded) {
      const metadata = parseFrontmatter(markdown);
      const textChunks = chunkText(this.#redact(stripImages(markdown)), {
        maxTokens: this.#chunkTokens,
        overlapTokens: this.#chunkOverlap,
      });
      let vectors: number[][] = [];
      if (embed && this.#semantic && available && textChunks.length > 0) {
        try {
          vectors = await this.#embedBatched(textChunks.map((chunk) => chunk.text));
        } catch {
          available = false;
          addWarning(warnings, keywordFallback);
        }
      }
      chunks.push(
        ...textChunks.map((chunk, index) => ({
          driveFileId: entry.id,
          drivePath: entry.path,
          ...metadata,
          chunkId: chunk.id,
          text: chunk.text,
          vector: vectors[index] ?? null,
        })),
      );
    }
    return { chunks, warnings, modelAvailable: available };
  }

  /**
   * One batch, one transaction. The listing's reset and removals run only with the
   * first batch. The drive cursor is published only when the listing is finished.
   */
  #commit(input: SyncBatch): void {
    const database = this.#database;
    const commit = database.transaction(() => {
      const deleteVectors = database.prepare(
        "DELETE FROM search_vectors WHERE drive_file_id = ?",
      );
      const deleteChunks = database.prepare(
        "DELETE FROM search_chunks WHERE drive_file_id = ?",
      );
      const deleteFts = database.prepare(
        "DELETE FROM search_chunks_fts WHERE drive_file_id = ?",
      );
      const remove = (id: string): void => {
        deleteVectors.run(id);
        deleteChunks.run(id);
        deleteFts.run(id);
      };
      if (input.applyListing) {
        if (input.work.reset) {
          database.exec("DELETE FROM search_vectors");
          database.exec("DELETE FROM search_chunks");
          database.exec("DELETE FROM search_chunks_fts");
        }
        for (const id of input.work.removed) remove(id);
      }
      for (const entry of input.batch) remove(entry.id);
      const insertChunk = database.prepare(`
        INSERT INTO search_chunks(
          drive_file_id, drive_path, source, conversation_id,
          started_at, updated_at, content_sha256, chunk_id, text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertVector = database.prepare(`
        INSERT INTO search_vectors(drive_file_id, chunk_id, dimensions, vector)
        VALUES (?, ?, ?, ?)
      `);
      const insertFts = database.prepare(`
        INSERT INTO search_chunks_fts(body, drive_file_id, chunk_id)
        VALUES (?, ?, ?)
      `);
      for (const chunk of input.chunks) {
        insertChunk.run(
          chunk.driveFileId,
          chunk.drivePath,
          chunk.source,
          chunk.conversationId,
          chunk.startedAt,
          chunk.updatedAt,
          chunk.contentSha256,
          chunk.chunkId,
          chunk.text,
        );
        if (chunk.vector) {
          insertVector.run(
            chunk.driveFileId,
            chunk.chunkId,
            chunk.vector.length,
            encodeVector(chunk.vector),
          );
        }
        insertFts.run(indexBody(chunk.text), chunk.driveFileId, chunk.chunkId);
      }
      const finished = input.next >= input.work.entries.length;
      if (!finished) {
        if (input.work.entries.length > SYNC_BATCH_ENTRIES) {
          this.#setManifest(PENDING_DONE_KEY, String(input.next));
        }
        return;
      }
      const manifest = database.prepare(`
        INSERT INTO manifest(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      manifest.run("model", this.#model);
      manifest.run("revision", this.#revision);
      manifest.run("dimensions", String(this.#dimensions));
      manifest.run("index_fingerprint", this.#indexFingerprint());
      manifest.run("generated_at", new Date().toISOString());
      database
        .prepare(
          `
          INSERT INTO cursors(key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `,
        )
        .run(SEARCH_DRIVE_CURSOR, input.work.cursor, new Date().toISOString());
      if (!input.modelAvailable) {
        this.#setManifest(VECTOR_RETRY_KEY, String(Date.now() + VECTOR_RETRY_MS));
      } else if (!this.#missingVector()) {
        // An empty follow-up must not clear the retry window while holes remain.
        database.prepare("DELETE FROM manifest WHERE key = ?").run(VECTOR_RETRY_KEY);
      }
      if (!input.embed) {
        this.#setManifest(VECTOR_MODE_KEY, "backfill");
      } else if (!this.#missingVector()) {
        this.#setManifest(VECTOR_MODE_KEY, "eager");
      }
      this.#clearPending();
    });
    commit();
  }

  status(): SearchStatus {
    ensureSearchSchema(this.#database);
    const count = this.#database
      .prepare("SELECT COUNT(DISTINCT drive_file_id) AS count FROM search_chunks")
      .get() as CountRow;
    const metadata = metadataMap(this.#database);
    const cursor = this.#database
      .prepare("SELECT value FROM cursors WHERE key = ?")
      .get(SEARCH_DRIVE_CURSOR) as { value: string } | null;
    return {
      ready: Boolean(cursor?.value) && !(PENDING_KEY in metadata),
      documents: count.count,
      ...(cursor?.value ? { cursor: cursor.value } : {}),
      ...(metadata.generated_at ? { generatedAt: metadata.generated_at } : {}),
    };
  }

  /**
   * Fills vector holes, newest document first, and stops when `budgetMs` is spent.
   * One embed call is capped by `embedCallTimeoutMs`. A timeout or model error
   * opens the retry window and later calls return without embedding.
   */
  async backfillVectors(options: { budgetMs?: number } = {}): Promise<{
    embedded: number;
    remaining: number;
    warnings: SearchOutput["warnings"];
  }> {
    if (!this.#semantic || this.#embedder === null) {
      return { embedded: 0, remaining: 0, warnings: [] };
    }
    ensureSearchSchema(this.#database);
    const retryAfter = Number(metadataMap(this.#database)[VECTOR_RETRY_KEY] ?? "0");
    if (Date.now() < retryAfter) {
      return { embedded: 0, remaining: this.#countMissingVectors(), warnings: [] };
    }
    const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs;
    const warnings: SearchOutput["warnings"] = [];
    let embedded = 0;
    const select = this.#database.prepare(
      `
      SELECT c.drive_file_id, c.chunk_id, c.text
      FROM search_chunks c
      LEFT JOIN search_vectors v
        ON v.drive_file_id = c.drive_file_id AND v.chunk_id = c.chunk_id
      WHERE v.chunk_id IS NULL
      ORDER BY c.updated_at DESC, c.drive_file_id ASC, c.chunk_id ASC
      LIMIT ?
    `,
    );
    while (true) {
      const batch = select.all(BACKFILL_CHUNK_BATCH) as Array<{
        drive_file_id: string;
        chunk_id: string;
        text: string;
      }>;
      if (batch.length === 0) break;
      let vectors: number[][];
      try {
        vectors = await this.#embedPassagesLimited(batch.map((row) => row.text));
        if (vectors.length !== batch.length) {
          throw new Error("Embedding model returned the wrong number of vectors");
        }
      } catch {
        addWarning(warnings, keywordFallback);
        this.#setManifest(VECTOR_RETRY_KEY, String(Date.now() + VECTOR_RETRY_MS));
        return { embedded, remaining: this.#countMissingVectors(), warnings };
      }
      this.#writeVectors(batch, vectors);
      embedded += batch.length;
      if (Date.now() >= deadline) break;
    }
    return { embedded, remaining: this.#countMissingVectors(), warnings };
  }

  #countMissingVectors(): number {
    const row = this.#database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM search_chunks c
        LEFT JOIN search_vectors v
          ON v.drive_file_id = c.drive_file_id AND v.chunk_id = c.chunk_id
        WHERE v.chunk_id IS NULL
      `,
      )
      .get() as CountRow;
    return row.count;
  }

  #writeVectors(
    batch: Array<{ drive_file_id: string; chunk_id: string }>,
    vectors: number[][],
  ): void {
    const database = this.#database;
    const write = database.transaction(() => {
      const insert = database.prepare(
        `
        INSERT INTO search_vectors(drive_file_id, chunk_id, dimensions, vector)
        VALUES (?, ?, ?, ?)
      `,
      );
      for (let index = 0; index < batch.length; index += 1) {
        const row = batch[index];
        const vector = vectors[index];
        if (!row || !vector) continue;
        insert.run(row.drive_file_id, row.chunk_id, vector.length, encodeVector(vector));
      }
    });
    write();
  }

  /**
   * Rank the local index, then add hits from other devices' sessions through Drive
   * full-text search. It never syncs the index; the daemon refreshes that itself.
   * MCP search_sessions and the HTTP search route use this.
   */
  async query(input: {
    query: string;
    limit: number;
    sources?: string[];
    since?: string;
    until?: string;
  }): Promise<SearchOutput> {
    const ready = this.status().ready;
    const warnings: SearchOutput["warnings"] = [];
    const local = await this.#rank(input, ready ? "fresh" : "stale", warnings);
    return this.#withRemote(input, local);
  }

  async search(input: {
    query: string;
    limit: number;
    sources?: string[];
    since?: string;
    until?: string;
  }): Promise<SearchOutput> {
    let indexStatus: SearchOutput["indexStatus"] = "fresh";
    const warnings: SearchOutput["warnings"] = [];
    try {
      const synced = await this.sync({ budgetMs: 3000, embed: false });
      warnings.push(...synced.warnings);
      if (!synced.done) {
        indexStatus = "stale";
        addWarning(warnings, staleIndex);
      }
    } catch {
      indexStatus = "stale";
      addWarning(warnings, staleIndex);
    }
    const local = await this.#rank(input, indexStatus, warnings);
    return this.#withRemote(input, local);
  }

  /** Other devices keep their sessions on Drive; ask Drive instead of indexing them here. */
  async #withRemote(
    input: {
      query: string;
      limit: number;
      sources?: string[];
      since?: string;
      until?: string;
    },
    local: SearchOutput,
  ): Promise<SearchOutput> {
    const drive = this.#drive;
    if (!this.#scope || !drive.searchText) return local;
    const terms = queryTerms(input.query);
    if (terms.length === 0) return local;
    const rangeInput: { since?: string; until?: string } = {};
    if (input.since) rangeInput.since = input.since;
    if (input.until) rangeInput.until = input.until;
    const range = parseSearchRange(rangeInput);
    const own = this.#scope();
    const found: SearchOutput["results"] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hits = await Promise.race([
        drive.searchText({
          text: input.query,
          prefix: "inbox/",
          limit: REMOTE_HITS * 2,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Drive search timed out")), REMOTE_SEARCH_TIMEOUT_MS);
        }),
      ]);
      for (const hit of hits) {
        if (found.length >= REMOTE_HITS) break;
        if (inScope(hit.path, own) || !hit.path.endsWith(".md")) continue;
        const markdown = Buffer.from((await drive.read(hit.id)).bytes).toString("utf8");
        const meta = parseFrontmatter(markdown);
        if (input.sources?.length && !input.sources.includes(meta.source)) continue;
        if (!updatedAtInRange(meta.updatedAt, range)) continue;
        found.push({
          score: 0,
          source: meta.source,
          conversationId: meta.conversationId,
          startedAt: meta.startedAt,
          updatedAt: meta.updatedAt,
          excerpt: excerptAround(markdown, terms),
          device: deviceOfInboxPath(hit.path),
          driveFileId: hit.id,
        });
      }
    } catch {
      const warnings = [...local.warnings];
      addWarning(warnings, remoteUnavailable);
      return { ...local, warnings };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const known = new Set(local.results.map((r) => `${r.source}:${r.conversationId}`));
    const remote = found.filter((r) => !known.has(`${r.source}:${r.conversationId}`));
    if (remote.length === 0) return local;
    const slots = Math.min(
      remote.length,
      Math.max(Math.floor(input.limit / 2), input.limit - local.results.length),
    );
    return {
      ...local,
      results: [...local.results.slice(0, input.limit - slots), ...remote.slice(0, slots)],
    };
  }

  async #rank(
    input: {
      query: string;
      limit: number;
      sources?: string[];
      since?: string;
      until?: string;
    },
    indexStatus: SearchOutput["indexStatus"],
    warnings: SearchOutput["warnings"],
  ): Promise<SearchOutput> {
    const rangeInput: { since?: string; until?: string } = {};
    if (input.since !== undefined && input.since.length > 0) rangeInput.since = input.since;
    if (input.until !== undefined && input.until.length > 0) rangeInput.until = input.until;
    const range = parseSearchRange(rangeInput);
    ensureSearchSchema(this.#database);
    const rows = this.#database
      .prepare(
        `
        SELECT c.drive_file_id, c.drive_path, c.source, c.conversation_id,
               c.started_at, c.updated_at, c.content_sha256, c.chunk_id, c.text,
               v.vector AS vector
        FROM search_chunks c
        LEFT JOIN search_vectors v
          ON v.drive_file_id = c.drive_file_id AND v.chunk_id = c.chunk_id
      `,
      )
      .all() as ChunkRow[];
    const lexical = keywordScores(this.#database, input.query);

    let queryVector: number[] | null = null;
    if (this.#semantic && rows.some((row) => row.vector !== null)) {
      try {
        queryVector = await this.#embedQuery(input.query);
      } catch {
        addWarning(warnings, keywordFallback);
      }
    } else if (this.#semantic && rows.length > 0) {
      addWarning(warnings, keywordFallback);
    }
    const searchMode: SearchOutput["searchMode"] = queryVector
      ? "semantic"
      : "keyword";
    const scored = rows
      .filter(
        (row) =>
          (!input.sources?.length || input.sources.includes(row.source)) &&
          updatedAtInRange(row.updated_at, range),
      )
      .map((row) => {
        const keyword = lexical.get(chunkKey(row.drive_file_id, row.chunk_id)) ?? 0;
        const vector = row.vector ? decodeVector(row.vector) : null;
        const semantic = queryVector && vector ? cosine(queryVector, vector) : 0;
        const score = queryVector ? semantic * 0.85 + keyword * 0.15 : keyword;
        return {
          score: Number(score.toFixed(6)),
          source: row.source,
          conversationId: row.conversation_id,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
          excerpt: row.text.replace(/\s+/gu, " ").trim().slice(0, 360),
        };
      })
      .filter((result) => queryVector !== null || result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.updatedAt.localeCompare(left.updatedAt),
      );
    const deduplicated = new Map<string, SearchOutput["results"][number]>();
    for (const result of scored) {
      const key = `${result.source}:${result.conversationId}`;
      const previous = deduplicated.get(key);
      if (!previous || result.score > previous.score) deduplicated.set(key, result);
    }
    const ranked = [...deduplicated.values()].sort(
      (left, right) =>
        right.score - left.score ||
        right.updatedAt.localeCompare(left.updatedAt),
    );
    return {
      query: input.query,
      indexStatus,
      searchMode,
      results: ranked.slice(0, input.limit),
      warnings,
    };
  }

  async #embedQuery(text: string): Promise<number[]> {
    const embedder = this.#embedder;
    if (!embedder) throw new Error("Embedding model is unavailable");
    return embedder.embedQuery(clampEmbedText(text, this.#maxChars));
  }

  async #embedPassagesLimited(texts: string[]): Promise<number[][]> {
    const embedder = this.#embedder;
    if (!embedder) throw new Error("Embedding model is unavailable");
    const clamped = texts.map((text) => clampEmbedText(text, this.#maxChars));
    const pending = embedder.embedPassages(clamped);
    void pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Embedding model timed out"));
          }, this.#embedCallTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #embedBatched(texts: string[]): Promise<number[][]> {
    const embedder = this.#embedder;
    if (!embedder) throw new Error("Embedding model is unavailable");
    const clamped = texts.map((text) => clampEmbedText(text, this.#maxChars));
    const vectors: number[][] = [];
    for (const batch of splitEmbedBatches(clamped, this.#batchSize)) {
      vectors.push(...(await embedder.embedPassages(batch)));
    }
    return vectors;
  }
}
