import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";

import { chunkText } from "./chunk-text.js";
import type { SearchDrive, SearchDriveEntry } from "./drive.js";
import type { Embedder } from "./embedder.js";
import { chunkKey, indexBody, keywordScores } from "./fts.js";
import { redactText, type RedactionOptions } from "./redact.js";
import { ensureSearchSchema, SEARCH_DRIVE_CURSOR } from "./schema.js";

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
  }>;
  warnings: Array<{ code: string; message: string }>;
}

export interface SearchStatus {
  ready: boolean;
  documents: number;
  cursor?: string;
  generatedAt?: string;
}

const keywordFallback = {
  code: "MODEL_UNAVAILABLE_KEYWORD_FALLBACK",
  message: "Embedding model is unavailable; using keyword search",
} as const;

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
  readonly #embedder: Embedder;
  readonly #database: Database;
  readonly #chunkTokens: number;
  readonly #chunkOverlap: number;
  readonly #redact: (text: string) => string;

  constructor(options: {
    drive: SearchDrive;
    embedder: Embedder;
    database: Database;
    chunkTokens?: number;
    chunkOverlap?: number;
    redact?: (text: string) => string;
    redaction?: RedactionOptions;
  }) {
    this.#drive = options.drive;
    this.#embedder = options.embedder;
    this.#database = options.database;
    this.#chunkTokens = options.chunkTokens ?? 448;
    this.#chunkOverlap = options.chunkOverlap ?? 64;
    const redaction = options.redaction;
    this.#redact =
      options.redact ??
      (redaction
        ? (text) => redactText(text, redaction).text
        : (text) => redactText(text).text);
    ensureSearchSchema(this.#database);
  }

  #indexFingerprint(): string {
    return JSON.stringify({
      model: this.#embedder.model,
      revision: this.#embedder.revision,
      dimensions: this.#embedder.dimensions,
      chunkTokens: this.#chunkTokens,
      chunkOverlap: this.#chunkOverlap,
    });
  }

  #cursor(): string | undefined {
    const metadata = metadataMap(this.#database);
    const missingVector = this.#database
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
    if (metadata.index_fingerprint !== this.#indexFingerprint() || missingVector) {
      return undefined;
    }
    const row = this.#database
      .prepare("SELECT value FROM cursors WHERE key = ?")
      .get(SEARCH_DRIVE_CURSOR) as { value: string } | null;
    return row?.value;
  }

  async sync(): Promise<{
    documents: number;
    warnings: SearchOutput["warnings"];
  }> {
    ensureSearchSchema(this.#database);
    const cursor = this.#cursor();
    const changes = await this.#drive.changes(
      cursor === undefined
        ? { prefix: "inbox/" }
        : { prefix: "inbox/", cursor },
    );
    const entries = changes.entries.filter(
      (entry) =>
        entry.path.startsWith("inbox/") &&
        (entry.mimeType === "text/markdown" || entry.path.endsWith(".md")),
    );
    const removedIds = new Set(changes.removedIds);
    for (const entry of changes.entries) {
      if (!entries.includes(entry)) removedIds.add(entry.id);
    }
    const chunks = await this.#indexEntries(entries);
    this.#replace(changes.reset, removedIds, entries, chunks.chunks, changes.cursor);
    const count = this.#database
      .prepare("SELECT COUNT(DISTINCT drive_file_id) AS count FROM search_chunks")
      .get() as CountRow;
    return { documents: count.count, warnings: chunks.warnings };
  }

  async #indexEntries(entries: SearchDriveEntry[]): Promise<{
    chunks: IndexedChunk[];
    warnings: SearchOutput["warnings"];
  }> {
    const chunks: IndexedChunk[] = [];
    const warnings: SearchOutput["warnings"] = [];
    let modelAvailable = true;
    for (const entry of entries) {
      const sourceObject = await this.#drive.read(entry.id);
      const markdown = new TextDecoder().decode(sourceObject.bytes);
      const metadata = parseFrontmatter(markdown);
      const textChunks = chunkText(this.#redact(stripImages(markdown)), {
        maxTokens: this.#chunkTokens,
        overlapTokens: this.#chunkOverlap,
      });
      let vectors: number[][] = [];
      if (modelAvailable && textChunks.length > 0) {
        try {
          vectors = await this.#embedder.embedPassages(
            textChunks.map((chunk) => chunk.text),
          );
        } catch {
          modelAvailable = false;
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
    return { chunks, warnings };
  }

  #replace(
    reset: boolean,
    removedIds: Set<string>,
    entries: SearchDriveEntry[],
    chunks: IndexedChunk[],
    cursor: string,
  ): void {
    const database = this.#database;
    const replace = database.transaction(() => {
      if (reset) {
        database.exec("DELETE FROM search_vectors");
        database.exec("DELETE FROM search_chunks");
        database.exec("DELETE FROM search_chunks_fts");
      }
      const deleteVectors = database.prepare(
        "DELETE FROM search_vectors WHERE drive_file_id = ?",
      );
      const deleteChunks = database.prepare(
        "DELETE FROM search_chunks WHERE drive_file_id = ?",
      );
      const deleteFts = database.prepare(
        "DELETE FROM search_chunks_fts WHERE drive_file_id = ?",
      );
      for (const id of [...removedIds, ...entries.map((entry) => entry.id)]) {
        deleteVectors.run(id);
        deleteChunks.run(id);
        deleteFts.run(id);
      }
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
      for (const chunk of chunks) {
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
      const manifest = database.prepare(`
        INSERT INTO manifest(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      manifest.run("model", this.#embedder.model);
      manifest.run("revision", this.#embedder.revision);
      manifest.run("dimensions", String(this.#embedder.dimensions));
      manifest.run("index_fingerprint", this.#indexFingerprint());
      manifest.run("generated_at", new Date().toISOString());
      database
        .prepare(`
          INSERT INTO cursors(key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `)
        .run(SEARCH_DRIVE_CURSOR, cursor, new Date().toISOString());
    });
    replace();
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
      ready: Boolean(cursor?.value),
      documents: count.count,
      ...(cursor?.value ? { cursor: cursor.value } : {}),
      ...(metadata.generated_at ? { generatedAt: metadata.generated_at } : {}),
    };
  }

  /**
   * Rank the local index. Does not call Drive. MCP search_sessions and the
   * HTTP search route use this; the daemon refreshes the index itself.
   */
  async query(input: {
    query: string;
    limit: number;
    sources?: string[];
    since?: string;
    until?: string;
  }): Promise<SearchOutput> {
    const ready = this.status().ready;
    return this.#rank(input, ready ? "fresh" : "stale", []);
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
      const synced = await this.sync();
      warnings.push(...synced.warnings);
    } catch {
      indexStatus = "stale";
      addWarning(warnings, staleIndex);
    }
    return this.#rank(input, indexStatus, warnings);
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
    if (rows.some((row) => row.vector !== null)) {
      try {
        queryVector = await this.#embedder.embedQuery(input.query);
      } catch {
        addWarning(warnings, keywordFallback);
      }
    } else if (rows.length > 0) {
      addWarning(warnings, keywordFallback);
    }
    const searchMode: SearchOutput["searchMode"] = queryVector
      ? "semantic"
      : "keyword";
    const scored = rows
      .filter(
        (row) =>
          (!input.sources?.length || input.sources.includes(row.source)) &&
          (!input.since || row.updated_at >= input.since) &&
          (!input.until || row.updated_at <= input.until),
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
}
