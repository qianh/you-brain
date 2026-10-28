import { Database } from "bun:sqlite";

import type { NotionBlockModel } from "./model.js";
import { blockPlainText } from "./model.js";

export interface NotionPageRow {
  pageId: string;
  object: "page" | "database";
  parentKind: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverUrl: string | null;
  lastEditedTime: string;
  createdAt: string;
}

export interface NotionPageBlockRow {
  blockId: string;
  pageId: string;
  parentBlockId: string | null;
  idx: number;
  model: NotionBlockModel;
}

export interface NotionDatabaseRow {
  databaseId: string;
  title: string;
  schema: Record<string, unknown>;
}

export interface NotionDatabaseRowRow {
  rowPageId: string;
  idx: number;
  title: string;
  icon: string | null;
  cells: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  page_id TEXT PRIMARY KEY,
  object TEXT NOT NULL,
  parent_kind TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  icon TEXT,
  cover_url TEXT,
  last_edited_time TEXT NOT NULL,
  created_time TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX IF NOT EXISTS pages_parent ON pages(parent_id);
CREATE TABLE IF NOT EXISTS blocks (
  block_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  parent_block_id TEXT,
  idx INTEGER NOT NULL,
  model TEXT NOT NULL,
  plain TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS blocks_page ON blocks(page_id, parent_block_id, idx);
CREATE TABLE IF NOT EXISTS databases (
  database_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  schema TEXT NOT NULL DEFAULT '{}',
  synced_at TEXT
);
CREATE TABLE IF NOT EXISTS db_rows (
  database_id TEXT NOT NULL,
  row_page_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  cells TEXT NOT NULL DEFAULT '{}',
  plain TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (database_id, row_page_id)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS notion_fts USING fts5(
  page_id,
  title,
  body,
  tokenize = 'trigram'
);
`;

/**
 * Local rebuildable index of synced Notion content, in its own
 * `<dataDir>/notion-index.sqlite`. Trigram FTS again, for CJK text.
 */
export class NotionIndex {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  meta(key: string): string | null {
    const row = this.#db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .query(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  upsertPage(page: NotionPageRow): void {
    this.#db
      .query(
        `INSERT INTO pages (page_id, object, parent_kind, parent_id, title, icon, cover_url, last_edited_time, created_time, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (page_id) DO UPDATE SET
           object = excluded.object,
           parent_kind = excluded.parent_kind,
           parent_id = excluded.parent_id,
           title = excluded.title,
           icon = excluded.icon,
           cover_url = excluded.cover_url,
           last_edited_time = excluded.last_edited_time,
           created_time = excluded.created_time,
           synced_at = excluded.synced_at`,
      )
      .run(
        page.pageId,
        page.object,
        page.parentKind,
        page.parentId,
        page.title,
        page.icon,
        page.coverUrl,
        page.lastEditedTime,
        page.createdAt,
        new Date().toISOString(),
      );
  }

  dropPage(pageId: string): void {
    const write = this.#db.transaction(() => {
      this.#db.query("DELETE FROM pages WHERE page_id = ?").run(pageId);
      this.#db.query("DELETE FROM blocks WHERE page_id = ?").run(pageId);
      this.#db.query("DELETE FROM notion_fts WHERE page_id = ?").run(pageId);
    });
    write();
  }

  replaceBlocks(
    pageId: string,
    blocks: readonly NotionPageBlockRow[],
    extraBody = "",
  ): void {
    const write = this.#db.transaction(() => {
      this.#db.query("DELETE FROM blocks WHERE page_id = ?").run(pageId);
      const insert = this.#db.query(
        `INSERT OR REPLACE INTO blocks (block_id, page_id, parent_block_id, idx, model, plain)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const row of blocks) {
        insert.run(
          row.blockId,
          row.pageId,
          row.parentBlockId,
          row.idx,
          JSON.stringify(row.model),
          blockPlainText(row.model),
        );
      }
      this.#refreshFts(pageId, extraBody);
    });
    write();
  }

  pageLastEdited(pageId: string): string | null {
    const row = this.#db
      .query<{ last_edited_time: string }, [string]>(
        "SELECT last_edited_time FROM pages WHERE page_id = ?",
      )
      .get(pageId);
    return row?.last_edited_time ?? null;
  }

  listPages(): NotionPageRow[] {
    return this.#db
      .query<Record<string, unknown>, []>(
        `SELECT page_id, object, parent_kind, parent_id, title, icon, cover_url,
                last_edited_time, created_time FROM pages ORDER BY created_time`,
      )
      .all()
      .map(fromPageRow);
  }

  countPages(): number {
    const row = this.#db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pages").get();
    return row?.n ?? 0;
  }

  /** Top-level page blocks as an ordered tree (children attached by parent id). */
  pageBlocks(pageId: string): NotionBlockModel[] {
    const rows = this.#db
      .query<{ block_id: string; parent_block_id: string | null; idx: number; model: string }, [string]>(
        "SELECT block_id, parent_block_id, idx, model FROM blocks WHERE page_id = ? ORDER BY idx",
      )
      .all(pageId);
    const byId = new Map<string, NotionBlockModel>();
    const roots: NotionBlockModel[] = [];
    const ordered: Array<{ row: typeof rows[number]; model: NotionBlockModel }> = [];
    for (const row of rows) {
      const model = JSON.parse(row.model) as NotionBlockModel;
      model.children = [];
      byId.set(row.block_id, model);
      ordered.push({ row, model });
    }
    for (const { row, model } of ordered) {
      const parent = row.parent_block_id === null ? null : byId.get(row.parent_block_id);
      if (parent) parent.children.push(model);
      else roots.push(model);
    }
    return roots;
  }

  blockPage(blockId: string): string | null {
    const row = this.#db
      .query<{ page_id: string }, [string]>("SELECT page_id FROM blocks WHERE block_id = ?")
      .get(blockId);
    return row?.page_id ?? null;
  }

  upsertDatabase(db: NotionDatabaseRow): void {
    this.#db
      .query(
        `INSERT INTO databases (database_id, title, schema, synced_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (database_id) DO UPDATE SET
           title = excluded.title, schema = excluded.schema, synced_at = excluded.synced_at`,
      )
      .run(db.databaseId, db.title, JSON.stringify(db.schema), new Date().toISOString());
  }

  replaceDatabaseRows(
    databaseId: string,
    rows: readonly (NotionDatabaseRowRow & { plain: string })[],
  ): void {
    const write = this.#db.transaction(() => {
      this.#db.query("DELETE FROM db_rows WHERE database_id = ?").run(databaseId);
      const insert = this.#db.query(
        `INSERT OR REPLACE INTO db_rows (database_id, row_page_id, idx, title, icon, cells, plain)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      rows.forEach((row, idx) => {
        insert.run(
          databaseId,
          row.rowPageId,
          idx,
          row.title,
          row.icon,
          JSON.stringify(row.cells),
          row.plain,
        );
      });
    });
    write();
  }

  database(databaseId: string): {
    databaseId: string;
    title: string;
    schema: Record<string, unknown>;
    rows: NotionDatabaseRowRow[];
  } | null {
    const dbRow = this.#db
      .query<{ database_id: string; title: string; schema: string }, [string]>(
        "SELECT database_id, title, schema FROM databases WHERE database_id = ?",
      )
      .get(databaseId);
    if (!dbRow) return null;
    const rows = this.#db
      .query<Record<string, unknown>, [string]>(
        "SELECT row_page_id, idx, title, icon, cells FROM db_rows WHERE database_id = ? ORDER BY idx",
      )
      .all(databaseId)
      .map((row) => ({
        rowPageId: String(row.row_page_id),
        idx: Number(row.idx),
        title: String(row.title),
        icon: row.icon === null ? null : String(row.icon),
        cells: JSON.parse(String(row.cells)) as Record<string, unknown>,
      }));
    return {
      databaseId: dbRow.database_id,
      title: dbRow.title,
      schema: JSON.parse(dbRow.schema) as Record<string, unknown>,
      rows,
    };
  }

  search(query: string, limit: number): Array<{ pageId: string; title: string; excerpt: string }> {
    const trimmed = query.trim();
    if (trimmed === "") return [];
    const escaped = trimmed.replaceAll('"', '""');
    const rows = this.#db
      .query<{ page_id: string; title: string; excerpt: string }, [string, number]>(
        `SELECT page_id, title, snippet(notion_fts, 2, '', '', ' … ', 16) AS excerpt
         FROM notion_fts WHERE notion_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(`"${escaped}"`, limit)
      .map((row) => ({
        pageId: row.page_id,
        title: row.title,
        excerpt: row.excerpt,
      }));
    if (rows.length > 0) return rows;
    // Trigram MATCH needs three characters; short queries fall back to LIKE.
    const like = `%${trimmed.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.#db
      .query<{ page_id: string; title: string; body: string }, [string, string, number]>(
        `SELECT page_id, title, body FROM notion_fts
         WHERE body LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(like, like, limit)
      .map((row) => {
        const at = row.body.toLowerCase().indexOf(trimmed.toLowerCase());
        const start = Math.max(0, at - 80);
        return {
          pageId: row.page_id,
          title: row.title,
          excerpt:
            at < 0
              ? row.body.slice(0, 160)
              : `${start > 0 ? "…" : ""}${row.body.slice(start, at + trimmed.length + 80)}…`,
        };
      });
  }

  #refreshFts(pageId: string, extraBody = ""): void {
    this.#db.query("DELETE FROM notion_fts WHERE page_id = ?").run(pageId);
    const page = this.#db
      .query<{ title: string }, [string]>("SELECT title FROM pages WHERE page_id = ?")
      .get(pageId);
    const blocks = this.#db
      .query<{ plain: string }, [string]>(
        "SELECT plain FROM blocks WHERE page_id = ? ORDER BY idx",
      )
      .all(pageId)
      .map((row) => row.plain);
    const body = extraBody === "" ? blocks.join("\n") : `${extraBody}\n${blocks.join("\n")}`;
    this.#db
      .query("INSERT INTO notion_fts (page_id, title, body) VALUES (?, ?, ?)")
      .run(pageId, page?.title ?? "", body);
  }

  forgetAll(): void {
    this.#db.exec("DELETE FROM pages; DELETE FROM blocks; DELETE FROM databases; DELETE FROM db_rows; DELETE FROM notion_fts; DELETE FROM meta;");
  }
}

function fromPageRow(row: Record<string, unknown>): NotionPageRow {
  return {
    pageId: String(row.page_id),
    object: row.object === "database" ? "database" : "page",
    parentKind: String(row.parent_kind),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
    title: String(row.title),
    icon: row.icon === null || row.icon === undefined ? null : String(row.icon),
    coverUrl: row.cover_url === null || row.cover_url === undefined ? null : String(row.cover_url),
    lastEditedTime: String(row.last_edited_time),
    createdAt: String(row.created_time),
  };
}
