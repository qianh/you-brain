import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { inboxScopePrefixes } from "../../src/search/scope.js";
import type { Embedder } from "../../src/search/embedder.js";
import { SearchService } from "../../src/search/search-service.js";
import { MemoryDrive } from "./memory-drive.js";

const embedder: Embedder = {
  model: "fast",
  revision: "v1",
  dimensions: 3,
  embedQuery: () => Promise.resolve([1, 0, 0]),
  embedPassages: (texts) => Promise.resolve(texts.map(() => [1, 0, 0])),
};

function markdown(conversationId: string): Uint8Array {
  return new TextEncoder().encode(`---
source: codex
conversation_id: ${conversationId}
started_at: 2026-07-18T01:00:00.000Z
updated_at: 2026-07-18T02:00:00.000Z
content_sha256: ${"a".repeat(64)}
---
## User
note ${conversationId} rollback
`);
}

async function putAll(drive: MemoryDrive): Promise<void> {
  for (const path of [
    "inbox/mac/own.md",
    "inbox/air/other.md",
    "inbox/air/another.md",
    "inbox/web-p1/web.md",
  ]) {
    await drive.put({ path, bytes: markdown(path), mimeType: "text/markdown" });
  }
}

function indexedPaths(database: Database): string[] {
  return (
    database
      .prepare("SELECT DISTINCT drive_path FROM search_chunks ORDER BY drive_path")
      .all() as Array<{ drive_path: string }>
  ).map((row) => row.drive_path);
}

describe("search scope", () => {
  it("indexes this device's folder and ignores other devices", async () => {
    const drive = new MemoryDrive();
    await putAll(drive);
    const database = new Database(":memory:");
    const service = new SearchService({
      drive,
      embedder,
      database,
      scope: () => inboxScopePrefixes({ device: "mac", includeWeb: false }),
    });

    await service.sync();

    expect(indexedPaths(database)).toEqual(["inbox/mac/own.md"]);
  });

  it("adds browser-plugin files only for the web processor", async () => {
    const drive = new MemoryDrive();
    await putAll(drive);
    const database = new Database(":memory:");
    const service = new SearchService({
      drive,
      embedder,
      database,
      scope: () => inboxScopePrefixes({ device: "mac", includeWeb: true }),
    });

    await service.sync();

    expect(indexedPaths(database)).toEqual(["inbox/mac/own.md", "inbox/web-p1/web.md"]);
  });

  it("drops documents of other devices that an earlier unscoped index kept", async () => {
    const drive = new MemoryDrive();
    await putAll(drive);
    const database = new Database(":memory:");
    await new SearchService({ drive, embedder, database }).sync();
    expect(indexedPaths(database)).toHaveLength(4);

    const scoped = new SearchService({
      drive,
      embedder,
      database,
      scope: () => inboxScopePrefixes({ device: "mac", includeWeb: false }),
    });
    await scoped.sync();

    expect(indexedPaths(database)).toEqual(["inbox/mac/own.md"]);
    expect(scoped.status().documents).toBe(1);
  });

  it("rejects a device name that is not a folder name without indexing everything", () => {
    expect(inboxScopePrefixes({ device: "a/b", includeWeb: false })).toEqual([]);
  });
  it("finds other devices' sessions through Drive without indexing them", async () => {
    const drive = new MemoryDrive();
    await putAll(drive);
    const database = new Database(":memory:");
    const service = new SearchService({
      drive,
      embedder,
      database,
      semantic: false,
      scope: () => inboxScopePrefixes({ device: "mac", includeWeb: false }),
    });
    await service.sync();

    const output = await service.query({ query: "rollback", limit: 10 });

    const remote = output.results.filter((hit) => hit.device !== undefined);
    expect(remote.map((hit) => hit.device).sort()).toEqual(["air", "air", "web-p1"]);
    expect(remote.every((hit) => hit.driveFileId !== undefined && hit.excerpt.includes("rollback"))).toBe(true);
    expect(output.results.filter((hit) => hit.device === undefined)).toHaveLength(1);
    expect(indexedPaths(database)).toEqual(["inbox/mac/own.md"]);
  });

  it("keeps local results and warns when Drive search fails", async () => {
    const drive = new MemoryDrive();
    await putAll(drive);
    const database = new Database(":memory:");
    const failing = {
      changes: (query: { prefix: string; cursor?: string }) => drive.changes(query),
      read: (id: string) => drive.read(id),
      searchText: () => Promise.reject(new Error("offline")),
    };
    const service = new SearchService({
      drive: failing,
      embedder,
      database,
      semantic: false,
      scope: () => inboxScopePrefixes({ device: "mac", includeWeb: false }),
    });
    await service.sync();

    const output = await service.query({ query: "rollback", limit: 10 });

    expect(output.results).toHaveLength(1);
    expect(output.warnings.map((warning) => warning.code)).toContain("REMOTE_SEARCH_UNAVAILABLE");
  });
});
