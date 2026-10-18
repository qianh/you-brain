import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureSearchSchema } from "../../src/search/schema.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";

describe("search schema on the shared store database", () => {
  it("reuses the store cursors table", () => {
    const dir = mkdtempSync(join(tmpdir(), "yb-search-compat-"));
    try {
      const path = join(dir, "state.sqlite");
      const store = new SqliteStore(path);
      const database = new Database(path);
      expect(() => ensureSearchSchema(database)).not.toThrow();
      database
        .prepare("INSERT INTO cursors(key, value, updated_at) VALUES (?, ?, ?)")
        .run("search.inbox", "token-1", new Date().toISOString());
      database.close();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
