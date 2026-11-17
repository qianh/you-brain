import type { Database } from "bun:sqlite";

export const SEARCH_DRIVE_CURSOR = "search.inbox";

const schema = `
  CREATE TABLE IF NOT EXISTS search_chunks (
    drive_file_id TEXT NOT NULL,
    drive_path TEXT NOT NULL,
    source TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (drive_file_id, chunk_id)
  );
  CREATE INDEX IF NOT EXISTS search_chunks_session
    ON search_chunks(source, conversation_id, updated_at);
  CREATE TABLE IF NOT EXISTS search_vectors (
    drive_file_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (drive_file_id, chunk_id),
    FOREIGN KEY (drive_file_id, chunk_id)
      REFERENCES search_chunks(drive_file_id, chunk_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS search_files (
    drive_file_id TEXT PRIMARY KEY,
    drive_path TEXT NOT NULL,
    md5 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS search_fts_rows (
    fts_rowid INTEGER PRIMARY KEY,
    drive_file_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS search_fts_rows_file ON search_fts_rows(drive_file_id);
  CREATE TABLE IF NOT EXISTS manifest (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS search_chunks_fts USING fts5(
    body,
    drive_file_id UNINDEXED,
    chunk_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;

interface TableInfo {
  name: string;
}

export function ensureSearchSchema(database: Database): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(schema);
  ensureCursors(database);
  backfillFtsRows(database);
}

const FTS_ROWS_KEY = "fts_rows_v1";

/**
 * `search_fts_rows` maps each full-text row to its file, so replacing a file deletes its FTS
 * rows by rowid. FTS5 cannot index `drive_file_id`; deleting by it scanned the whole table,
 * one to two seconds on the daemon's thread per committed batch. Indexes built before the
 * map get it filled once from the FTS table.
 */
function backfillFtsRows(database: Database): void {
  const done = database.prepare("SELECT 1 FROM manifest WHERE key = ?").get(FTS_ROWS_KEY);
  if (done) return;
  database.transaction(() => {
    database.exec("DELETE FROM search_fts_rows");
    database.exec("INSERT INTO search_fts_rows(fts_rowid, drive_file_id) SELECT rowid, drive_file_id FROM search_chunks_fts");
    database.prepare("INSERT INTO manifest(key, value) VALUES (?, '1')").run(FTS_ROWS_KEY);
  })();
}

function ensureCursors(database: Database): void {
  const existing = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cursors'",
    )
    .get() as { name: string } | null;
  if (!existing) {
    database.exec(`
      CREATE TABLE cursors (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    return;
  }
  const columns = database.prepare("PRAGMA table_info(cursors)").all() as TableInfo[];
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("key") || !names.has("value") || !names.has("updated_at")) {
    throw new Error(
      `cursors table is incompatible with search; expected columns key, value and updated_at, found ${[...names].join(", ")}`,
    );
  }
}
