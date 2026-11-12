import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
  CaptureWorkerTimeoutError,
  captureFileStamp,
  captureGeneration,
  collectCaptureHits,
  parsePsTime,
  waitCaptureChild,
  type CaptureScanRequest,
} from "../../src/daemon/capture-scan.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("capture worker deadline", () => {
  it("parses ps cpu time", () => {
    expect(parsePsTime("0:14.97")).toBeCloseTo(14.97);
    expect(parsePsTime("  1:02:03 ")).toBe(3723);
    expect(parsePsTime("2-01:00:00")).toBe(2 * 86400 + 3600);
    expect(parsePsTime("nope")).toBeNull();
  });

  it("returns a worker that exits", async () => {
    const child = Bun.spawn(["/bin/sh", "-c", "echo worker-ok >&2; exit 0"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const result = await waitCaptureChild(child, {
      timeoutMs: 5_000,
      stallMs: 60_000,
      cpuSeconds: async () => null,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("worker-ok");
  });

  it("kills a worker that never exits", async () => {
    const child = Bun.spawn(["sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const started = Date.now();
    let caught: unknown;
    try {
      await waitCaptureChild(child, {
        timeoutMs: 200,
        stallMs: 60_000,
        cpuSeconds: async () => null,
        killGraceMs: 200,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CaptureWorkerTimeoutError);
    expect(caught).toMatchObject({ reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await child.exited).not.toBe(0);
  });

  it("kills a worker whose cpu time stops moving", async () => {
    const child = Bun.spawn(["sleep", "30"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const started = Date.now();
    let caught: unknown;
    try {
      await waitCaptureChild(child, {
        timeoutMs: 30_000,
        stallMs: 80,
        pollMs: 20,
        cpuSeconds: async () => 1,
        killGraceMs: 200,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CaptureWorkerTimeoutError);
    expect(caught).toMatchObject({ reason: "stall" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await child.exited).not.toBe(0);
  });
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
