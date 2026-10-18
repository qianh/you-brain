import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";

import type { Embedder } from "../../src/search/embedder.js";
import { SEARCH_DRIVE_CURSOR } from "../../src/search/schema.js";
import { SearchService } from "../../src/search/search-service.js";
import { MemoryDrive } from "./memory-drive.js";

class SemanticEmbedder implements Embedder {
  readonly model = "semantic-test";
  readonly revision = "v1";
  readonly dimensions = 3;

  async embedQuery(text: string): Promise<number[]> {
    return this.#vector(text);
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.#vector(text));
  }

  #vector(text: string): number[] {
    const lower = text.toLowerCase();
    const raw = [
      /deploy|release|发布/u.test(lower) ? 1 : 0,
      /database|sqlite|数据库/u.test(lower) ? 1 : 0,
      /portrait|画像/u.test(lower) ? 1 : 0,
    ];
    const norm = Math.hypot(...raw) || 1;
    return raw.map((value) => value / norm);
  }
}

class UnavailableEmbedder implements Embedder {
  readonly model = "unavailable-test";
  readonly revision = "v1";
  readonly dimensions = 3;

  async embedQuery(): Promise<number[]> {
    throw new Error("model unavailable");
  }

  async embedPassages(): Promise<number[][]> {
    throw new Error("model unavailable");
  }
}

class RecoveringEmbedder implements Embedder {
  readonly model = "recovering-test";
  readonly revision = "v1";
  readonly dimensions = 3;
  available = false;

  async embedQuery(): Promise<number[]> {
    if (!this.available) throw new Error("model unavailable");
    return [1, 0, 0];
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    if (!this.available) throw new Error("model unavailable");
    return texts.map(() => [1, 0, 0]);
  }
}

class ConfigurableEmbedder implements Embedder {
  readonly model = "structural-test";
  readonly revision = "v1";

  constructor(readonly dimensions: number) {}

  async embedQuery(): Promise<number[]> {
    return [1, ...Array.from({ length: this.dimensions - 1 }, () => 0)];
  }

  async embedPassages(texts: string[]): Promise<number[][]> {
    return texts.map(() => [
      1,
      ...Array.from({ length: this.dimensions - 1 }, () => 0),
    ]);
  }
}

function markdown(fields: {
  source: string;
  conversationId: string;
  contentSha: string;
  text: string;
}): Uint8Array {
  return new TextEncoder().encode(`---
source: ${fields.source}
conversation_id: ${fields.conversationId}
started_at: 2026-07-18T01:00:00.000Z
updated_at: 2026-07-18T02:00:00.000Z
content_sha256: ${fields.contentSha}
---
## User
${fields.text}
`);
}

function openDatabase(): Database {
  return new Database(":memory:");
}

describe("local hybrid search", () => {
  it("indexes only inbox content in local SQLite without writing to Drive", async () => {
    const drive = new MemoryDrive();
    const driveWrite = spyOn(drive, "upsert");
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "conversation-1",
        contentSha: "a".repeat(64),
        text: "Use a canary rollout for production.",
      }),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "sessions/2026-07/legacy.md",
      bytes: markdown({
        source: "codex",
        conversationId: "legacy-session",
        contentSha: "b".repeat(64),
        text: "Release the legacy session.",
      }),
      mimeType: "text/markdown",
    });
    const database = openDatabase();
    const service = new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
      database,
    });

    const result = await service.search({
      query: "release strategy",
      limit: 10,
    });

    expect(result).toMatchObject({
      indexStatus: "fresh",
      searchMode: "semantic",
      results: [
        {
          source: "codex",
          conversationId: "conversation-1",
        },
      ],
    });
    expect(result.results[0]).not.toHaveProperty("driveFileId");
    expect(result.results[0]).not.toHaveProperty("kind");
    expect(driveWrite).not.toHaveBeenCalled();
    expect(drive.list({ prefix: "_meta/search/" })).toEqual([]);
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "cursors",
        "manifest",
        "search_chunks",
        "search_chunks_fts",
        "search_vectors",
      ]),
    );
    const cursor = database
      .prepare("SELECT value FROM cursors WHERE key = ?")
      .get(SEARCH_DRIVE_CURSOR) as { value: string };
    expect(cursor.value).not.toBe("");
  });

  it("uses the last local index and warns when Drive refresh fails", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "conversation-1",
        contentSha: "c".repeat(64),
        text: "Database migration with SQLite.",
      }),
      mimeType: "text/markdown",
    });
    const database = openDatabase();
    await new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
      database,
    }).sync();
    drive.failChanges(true);

    const result = await new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
      database,
    }).search({ query: "sqlite", limit: 10 });

    expect(result.indexStatus).toBe("stale");
    expect(result.results[0]?.conversationId).toBe("conversation-1");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "INDEX_STALE" }),
    );
  });

  it("persists and resumes the Drive change cursor", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "incremental-session",
        contentSha: "e".repeat(64),
        text: "First revision.",
      }),
      mimeType: "text/markdown",
    });
    const read = spyOn(drive, "read");
    const service = new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
      database: openDatabase(),
    });

    await service.sync();
    await service.sync();
    expect(read).toHaveBeenCalledTimes(1);

    await drive.upsert({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "incremental-session",
        contentSha: "f".repeat(64),
        text: "Second revision.",
      }),
      mimeType: "text/markdown",
    });
    await service.sync();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("falls back explicitly to keyword search when the model is unavailable", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/codex.md",
      bytes: markdown({
        source: "codex",
        conversationId: "keyword-session",
        contentSha: "d".repeat(64),
        text: "The launch checklist contains a rollback step.",
      }),
      mimeType: "text/markdown",
    });
    const service = new SearchService({
      drive,
      embedder: new UnavailableEmbedder(),
      database: openDatabase(),
    });

    const result = await service.search({ query: "rollback", limit: 10 });

    expect(result.searchMode).toBe("keyword");
    expect(result.results[0]?.conversationId).toBe("keyword-session");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "MODEL_UNAVAILABLE_KEYWORD_FALLBACK" }),
    );
  });

  it("rebuilds missing vectors after a temporarily unavailable model recovers", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/recover.md",
      bytes: markdown({
        source: "codex",
        conversationId: "recovery-session",
        contentSha: "1".repeat(64),
        text: "Release recovery procedure.",
      }),
      mimeType: "text/markdown",
    });
    const embedder = new RecoveringEmbedder();
    const service = new SearchService({
      drive,
      embedder,
      database: openDatabase(),
    });

    const degraded = await service.search({ query: "release", limit: 10 });
    embedder.available = true;
    const recovered = await service.search({ query: "release", limit: 10 });

    expect(degraded.searchMode).toBe("keyword");
    expect(recovered).toMatchObject({
      indexStatus: "fresh",
      searchMode: "semantic",
      results: [{ conversationId: "recovery-session" }],
    });
  });

  it.each([
    {
      label: "embedding dimensions",
      first: { dimensions: 3, chunkTokens: 448, chunkOverlap: 64 },
      second: { dimensions: 4, chunkTokens: 448, chunkOverlap: 64 },
    },
    {
      label: "chunk size",
      first: { dimensions: 3, chunkTokens: 448, chunkOverlap: 64 },
      second: { dimensions: 3, chunkTokens: 320, chunkOverlap: 64 },
    },
    {
      label: "chunk overlap",
      first: { dimensions: 3, chunkTokens: 448, chunkOverlap: 64 },
      second: { dimensions: 3, chunkTokens: 448, chunkOverlap: 32 },
    },
  ])("rebuilds the index when $label changes", async ({ first, second }) => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/structural.md",
      bytes: markdown({
        source: "codex",
        conversationId: "structural-session",
        contentSha: "2".repeat(64),
        text: "Database release notes.",
      }),
      mimeType: "text/markdown",
    });
    const database = openDatabase();
    await new SearchService({
      drive,
      embedder: new ConfigurableEmbedder(first.dimensions),
      database,
      chunkTokens: first.chunkTokens,
      chunkOverlap: first.chunkOverlap,
    }).sync();
    const read = spyOn(drive, "read");

    await new SearchService({
      drive,
      embedder: new ConfigurableEmbedder(second.dimensions),
      database,
      chunkTokens: second.chunkTokens,
      chunkOverlap: second.chunkOverlap,
    }).sync();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("mixes FTS keyword rank with the semantic score", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/semantic.md",
      bytes: markdown({
        source: "codex",
        conversationId: "semantic-session",
        contentSha: "3".repeat(64),
        text: "Database migration with SQLite.",
      }),
      mimeType: "text/markdown",
    });
    await drive.put({
      path: "inbox/mac/keyword.md",
      bytes: markdown({
        source: "claude-code",
        conversationId: "keyword-only",
        contentSha: "4".repeat(64),
        text: "The launch checklist contains a rollback step.",
      }),
      mimeType: "text/markdown",
    });
    const service = new SearchService({
      drive,
      embedder: new SemanticEmbedder(),
      database: openDatabase(),
    });

    const hybrid = await service.search({
      query: "sqlite rollback",
      limit: 10,
    });

    expect(hybrid.searchMode).toBe("semantic");
    expect(hybrid.results.map((result) => result.conversationId)).toEqual([
      "semantic-session",
      "keyword-only",
    ]);
    const semantic = hybrid.results[0];
    const keyword = hybrid.results[1];
    expect(semantic?.score).toBeGreaterThan(keyword?.score ?? 1);
  });

  it("matches Chinese keywords through FTS5 character tokens", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/zh.md",
      bytes: markdown({
        source: "grok-build",
        conversationId: "chinese-session",
        contentSha: "5".repeat(64),
        text: "讨论发布流程和回滚步骤。",
      }),
      mimeType: "text/markdown",
    });
    const service = new SearchService({
      drive,
      embedder: new UnavailableEmbedder(),
      database: openDatabase(),
    });

    const result = await service.search({ query: "发布流程", limit: 5 });

    expect(result.searchMode).toBe("keyword");
    expect(result.results[0]?.conversationId).toBe("chinese-session");
  });

  it("does not treat an English substring as a keyword hit", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/db.md",
      bytes: markdown({
        source: "codex",
        conversationId: "database-session",
        contentSha: "6".repeat(64),
        text: "Database migration with SQLite.",
      }),
      mimeType: "text/markdown",
    });
    const service = new SearchService({
      drive,
      embedder: new UnavailableEmbedder(),
      database: openDatabase(),
    });

    const partial = await service.search({ query: "base", limit: 5 });
    const whole = await service.search({ query: "database", limit: 5 });

    expect(partial.results).toEqual([]);
    expect(whole.results[0]?.conversationId).toBe("database-session");
  });

  it("stores redacted text and omits image payloads", async () => {
    const drive = new MemoryDrive();
    await drive.put({
      path: "inbox/mac/secret.md",
      bytes: markdown({
        source: "codex",
        conversationId: "secret-session",
        contentSha: "7".repeat(64),
        text: "api_key=sk-abcdefghijklmnopqrstuvwxyz123456 ![shot](https://example.com/a.png)",
      }),
      mimeType: "text/markdown",
    });
    const database = openDatabase();
    const service = new SearchService({
      drive,
      embedder: new UnavailableEmbedder(),
      database,
    });

    const result = await service.search({ query: "REDACTED", limit: 5 });
    const stored = (
      database.prepare("SELECT text FROM search_chunks").all() as Array<{
        text: string;
      }>
    )
      .map((row) => row.text)
      .join("\n");

    expect(result.results[0]?.conversationId).toBe("secret-session");
    expect(stored).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(stored).toContain("[REDACTED]");
    expect(stored).toContain("[image omitted]");
    expect(stored).not.toContain("https://example.com/a.png");
  });
});
