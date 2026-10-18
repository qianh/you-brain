import { YouBrainError } from "../domain/errors.js";
import { ConflictError } from "../drive/errors.js";
import type { DriveEntry, DrivePort, DriveUpdateOptions } from "../drive/drive-port.js";
import { assertChecksum } from "./checksum.js";
import type { JsonUpdateResult } from "./types.js";

const defaultAttempts = 5;

export type JsonMerge<T> = (current: T | null) => T | Promise<T>;

function asBuffer(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

function attempts(value: number | undefined): number {
  return Math.max(1, value ?? defaultAttempts);
}

function serializeJson(value: unknown): Buffer {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) {
    throw new YouBrainError("INVALID_INPUT", "JSON merge returned a value that is not JSON");
  }
  return Buffer.from(`${text}\n`, "utf8");
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new YouBrainError("INVALID_INPUT", "Drive JSON file is not valid JSON");
  }
}

/**
 * In-place update of one path. The fileId stays stable across calls.
 * A 412 is re-read and retried up to `maxAttempts` times.
 */
export async function upsertByPath(
  drive: DrivePort,
  path: string,
  content: string | Uint8Array,
  options?: {
    mimeType?: string;
    appProperties?: Record<string, string>;
    maxAttempts?: number;
  },
): Promise<DriveEntry> {
  const bytes = asBuffer(content);
  const mimeType = options?.mimeType ?? "application/octet-stream";
  const limit = attempts(options?.maxAttempts);
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const existing = await drive.findByPath(path);
    try {
      if (!existing) {
        const created = await drive.create({
          path,
          bytes,
          mimeType,
          ...(options?.appProperties ? { appProperties: options.appProperties } : {}),
        });
        assertChecksum(created, bytes);
        return created;
      }
      const current = await drive.read(existing.id);
      const updateOptions: DriveUpdateOptions = {
        ifMatch: current.etag,
        mimeType,
      };
      if (options?.appProperties) updateOptions.appProperties = options.appProperties;
      const updated = await drive.update(existing.id, bytes, updateOptions);
      assertChecksum(updated, bytes);
      return updated;
    } catch (error) {
      if (error instanceof ConflictError) continue;
      throw error;
    }
  }
  throw new ConflictError("upsertByPath exceeded the retry limit");
}

/**
 * Optimistic-lock JSON update. On 412 the file is read again, `merge` runs
 * against that version, and the write is retried.
 */
export async function updateJsonWithMerge<T>(
  drive: DrivePort,
  path: string,
  merge: JsonMerge<T>,
  options?: { maxAttempts?: number },
): Promise<JsonUpdateResult<T>> {
  const limit = attempts(options?.maxAttempts);
  for (let attempt = 0; attempt < limit; attempt += 1) {
    const existing = await drive.findByPath(path);
    let current: T | null = null;
    let fileId: string | undefined;
    let etag: string | undefined;
    if (existing) {
      const object = await drive.read(existing.id);
      current = parseJson(object.bytes) as T;
      fileId = object.id;
      etag = object.etag;
    }
    const value = await merge(current);
    const bytes = serializeJson(value);
    try {
      const file = fileId
        ? await drive.update(fileId, bytes, {
            ifMatch: etag ?? "",
            mimeType: "application/json",
          })
        : await drive.create({
            path,
            bytes,
            mimeType: "application/json",
          });
      assertChecksum(file, bytes);
      return { file, value };
    } catch (error) {
      if (error instanceof ConflictError) continue;
      throw error;
    }
  }
  throw new ConflictError("updateJsonWithMerge exceeded the retry limit");
}
