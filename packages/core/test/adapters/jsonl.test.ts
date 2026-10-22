import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  JSONL_READ_CHUNK_BYTES,
  consumeJsonLines,
  forEachJsonLine,
  readJsonLines,
} from "../../src/adapters/jsonl.js";

function oracle(text: string): { records: unknown[]; malformedLines: number } {
  const records: unknown[] = [];
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as unknown);
    } catch {
      malformedLines += 1;
    }
  }
  return { records, malformedLines };
}

async function consumeChunks(
  text: string,
  chunkBytes: number,
): Promise<{
  records: unknown[];
  malformedLines: number;
  reads: number;
  maxRead: number;
  firstDeliveredAt: number;
}> {
  const bytes = Buffer.from(text);
  let offset = 0;
  let reads = 0;
  let maxRead = 0;
  let firstDeliveredAt = -1;
  const records: unknown[] = [];
  const { malformedLines } = await consumeJsonLines(async () => {
    if (offset >= bytes.length) return null;
    const end = Math.min(offset + chunkBytes, bytes.length);
    const chunk = bytes.subarray(offset, end);
    reads += 1;
    maxRead = Math.max(maxRead, chunk.length);
    offset = end;
    return new Uint8Array(chunk);
  }, (value) => {
    if (records.length === 0) firstDeliveredAt = offset;
    records.push(value);
  });
  return { records, malformedLines, reads, maxRead, firstDeliveredAt };
}

describe("jsonl streaming", () => {
  it("matches a whole-file parse for CRLF, blank lines, malformed lines, and a missing newline", async () => {
    const text = [
      '{"n":1}\r',
      "",
      " \t",
      "{not json}",
      '{"text":"中文"}',
    ].join("\n");
    const expected = oracle(text);
    const chunked = await consumeChunks(text, 3);
    expect(chunked.records).toEqual(expected.records);
    expect(chunked.malformedLines).toEqual(expected.malformedLines);
    expect(chunked.reads).toBeGreaterThan(1);
    expect(chunked.maxRead).toBeLessThanOrEqual(3);
  });

  it("does not read a large file in one chunk and still returns every record", async () => {
    const huge = "y".repeat(JSONL_READ_CHUNK_BYTES + 1024);
    const text = [
      JSON.stringify({ id: "first", text: "visible" }),
      JSON.stringify({ id: "blob", arguments: huge }),
      JSON.stringify({ id: "last", text: "kept" }),
      "",
    ].join("\n");
    expect(Buffer.byteLength(text)).toBeGreaterThan(JSONL_READ_CHUNK_BYTES);
    const expected = oracle(text);
    const chunked = await consumeChunks(text, JSONL_READ_CHUNK_BYTES);
    expect(chunked.reads).toBeGreaterThan(1);
    expect(chunked.maxRead).toBeLessThanOrEqual(JSONL_READ_CHUNK_BYTES);
    expect(chunked.maxRead).toBeLessThan(Buffer.byteLength(text));
    expect(chunked.firstDeliveredAt).toBeGreaterThan(0);
    expect(chunked.firstDeliveredAt).toBeLessThan(Buffer.byteLength(text));
    expect(chunked.records).toEqual(expected.records);
    expect(chunked.malformedLines).toBe(0);

    const root = await mkdtemp(join(tmpdir(), "you-brain-jsonl-"));
    const path = join(root, "session.jsonl");
    await writeFile(path, text);
    const fromFile = await readJsonLines(path);
    expect(fromFile).toEqual(expected);
    const visited: unknown[] = [];
    const streamed = await forEachJsonLine(path, (value) => {
      visited.push(value);
    });
    expect(visited).toEqual(expected.records);
    expect(streamed.malformedLines).toBe(0);
  });
});
