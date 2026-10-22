import { open } from "node:fs/promises";

/** Reads stay at this size so a multi-megabyte JSONL file is never one string. */
export const JSONL_READ_CHUNK_BYTES = 64 * 1024;

/** A single decoded line at least this long is collected before the next line. */
const JSONL_GC_LINE_CHARS = 256 * 1024;

export async function consumeJsonLines(
  read: () => Promise<Uint8Array | null>,
  visit: (value: unknown) => void,
): Promise<{ malformedLines: number }> {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let pending = new Uint8Array(0);
  let malformedLines = 0;

  const takeLine = (bytes: Uint8Array): number => {
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 13) end -= 1;
    const line = decoder.decode(end === bytes.length ? bytes : bytes.subarray(0, end));
    if (!line.trim()) return 0;
    try {
      visit(JSON.parse(line) as unknown);
    } catch {
      malformedLines += 1;
    }
    return line.length;
  };

  const append = (
    left: Uint8Array<ArrayBuffer>,
    right: Uint8Array<ArrayBuffer>,
  ): Uint8Array<ArrayBuffer> => {
    const merged = new Uint8Array(left.length + right.byteLength);
    merged.set(left);
    merged.set(right, left.length);
    return merged;
  };

  for (;;) {
    const chunk = await read();
    if (!chunk || chunk.byteLength === 0) break;
    const incoming = new Uint8Array(chunk.byteLength);
    incoming.set(chunk);
    pending = append(pending, incoming);
    let start = 0;
    while (start < pending.length) {
      const newline = pending.indexOf(10, start);
      if (newline < 0) break;
      const size = takeLine(pending.subarray(start, newline));
      start = newline + 1;
      if (size >= JSONL_GC_LINE_CHARS) {
        pending = pending.slice(start);
        start = 0;
        Bun.gc(true);
      }
    }
    if (start > 0) pending = pending.slice(start);
  }
  if (pending.length > 0) {
    const tail = pending;
    pending = new Uint8Array(0);
    const size = takeLine(tail);
    if (size >= JSONL_GC_LINE_CHARS) Bun.gc(true);
  }
  return { malformedLines };
}

export async function forEachJsonLine(
  path: string,
  visit: (value: unknown) => void,
  signal?: AbortSignal,
): Promise<{ malformedLines: number }> {
  if (signal?.aborted) throw abortError();
  const handle = await open(path, "r");
  try {
    const scratch = Buffer.allocUnsafe(JSONL_READ_CHUNK_BYTES);
    return await consumeJsonLines(async () => {
      if (signal?.aborted) throw abortError();
      const { bytesRead } = await handle.read(scratch);
      if (bytesRead === 0) return null;
      const copy = new Uint8Array(bytesRead);
      copy.set(scratch.subarray(0, bytesRead));
      return copy;
    }, visit);
  } finally {
    await handle.close();
  }
}

export async function readJsonLines(
  path: string,
  signal?: AbortSignal,
): Promise<{ records: unknown[]; malformedLines: number }> {
  const records: unknown[] = [];
  const { malformedLines } = await forEachJsonLine(
    path,
    (value) => {
      records.push(value);
    },
    signal,
  );
  return { records, malformedLines };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
