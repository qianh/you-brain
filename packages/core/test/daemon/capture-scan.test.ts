import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  captureFileStamp,
  captureGeneration,
  collectCaptureHits,
  type CaptureScanRequest,
} from "../../src/daemon/capture-scan.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("capture scan metadata", () => {
  it("stamps a row-backed database with its write-ahead log", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-capture-wal-"));
    roots.push(root);
    const database = join(root, "db.sqlite");
    await writeFile(database, "db");
    const withoutWal = await captureFileStamp(`${database}#session-1`);
    await writeFile(`${database}-wal`, "more rows");
    const withWal = await captureFileStamp(`${database}#session-1`);
    expect(withoutWal?.stamp).toBeString();
    expect(withWal?.stamp).not.toBe(withoutWal?.stamp);
    expect(withWal?.bytes).toBeGreaterThan(withoutWal?.bytes ?? 0);
    // The same row in an unchanged log keeps its stamp, so the next scan skips it.
    expect((await captureFileStamp(`${database}#session-1`))?.stamp).toBe(withWal?.stamp);
  });

  it("returns the same session on a second pass without parsing it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "you-brain-capture-scan-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({
        type: "user",
        isSidechain: false,
        sessionId: "scan-1",
        timestamp: "2026-10-18T02:00:00.000Z",
        message: { role: "user", content: "Plan the launch checklist" },
      })}\n`,
    );
    const request: CaptureScanRequest = {
      device: "device-a",
      includeSubagents: false,
      keepToolCalls: false,
      redact: true,
      generation: captureGeneration({
        includeSubagents: false,
        keepToolCalls: false,
        redact: true,
      }),
      sources: ["claude-code"],
      paths: { claude: [root], codex: [], grok: [], cursor: [] },
      sourceFilters: {},
      cursors: {},
    };
    const first = await collectCaptureHits(request);
    expect(first).toHaveLength(1);
    const hit = first[0];
    if (!hit?.meta) throw new Error("missing hit");
    expect(hit.unchanged).toBe(false);
    expect(hit.meta.conversationId).toBe("scan-1");
    expect(hit.meta.turnCount).toBe(1);
    const second = await collectCaptureHits({
      ...request,
      cursors: {
        [path]: {
          stamp: hit.stamp,
          key: hit.key,
          generation: request.generation,
          sourcePath: path,
        },
      },
    });
    expect(second).toEqual([
      {
        index: 0,
        path,
        stamp: hit.stamp,
        key: hit.key,
        meta: null,
        unchanged: true,
      },
    ]);
  });
});
