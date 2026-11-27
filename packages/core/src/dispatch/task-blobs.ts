import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TASK_IMAGE_MAX_BYTES } from "../tasks/types.js";

const STAGING_TTL_MS = 10 * 60_000;
const MAX_UPLOADS_PER_SENDER = 12;
const MAX_TOTAL_BYTES_PER_SENDER = 40 * 1024 * 1024;
const MAX_CHUNK_BYTES = 44 * 1024;

interface StagedUpload {
  uploadId: string;
  from: string;
  name: string;
  mimeType: string;
  totalBytes: number;
  receivedBytes: number;
  ready: boolean;
  updatedAt: number;
  filePath: string;
}

export interface BlobPutInput {
  uploadId: string;
  name: string;
  mimeType?: string | undefined;
  totalBytes: number;
  offset: number;
  chunk: string;
  final: boolean;
}

export interface BlobPutResult {
  uploadId: string;
  receivedBytes: number;
  ready: boolean;
}

/**
 * 跨设备 TODO 附件分块上传暂存区：按发送方绑定 uploadId，防止跨设备越权引用；
 * 落盘到 `<dataDir>/tasks/staging/`，消费或超时后自动清理。
 */
export class TaskBlobStaging {
  readonly #dir: string;
  readonly #uploads = new Map<string, StagedUpload>();

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "tasks", "staging");
  }

  async put(from: string, args: BlobPutInput, now: number): Promise<BlobPutResult> {
    await this.#prune(now);

    const chunkBytes = Buffer.from(args.chunk, "base64");
    if (chunkBytes.length === 0 || chunkBytes.length > MAX_CHUNK_BYTES) {
      throw new Error("附件分块大小不合法");
    }
    if (args.totalBytes <= 0 || args.totalBytes > TASK_IMAGE_MAX_BYTES) {
      throw new Error("附件不能为空且单个不能超过 10 MB");
    }

    let entry = this.#uploads.get(args.uploadId);
    if (args.offset === 0) {
      if (entry && entry.from !== from) {
        throw new Error("附件上传编号已被占用");
      }
      if (entry) {
        await rm(entry.filePath, { force: true }).catch(() => undefined);
        this.#uploads.delete(args.uploadId);
      }
      this.#assertSenderQuota(from, args.totalBytes);
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      const filePath = join(this.#dir, `${args.uploadId}.bin`);
      entry = {
        uploadId: args.uploadId,
        from,
        name: args.name,
        mimeType: args.mimeType?.trim() || "application/octet-stream",
        totalBytes: args.totalBytes,
        receivedBytes: 0,
        ready: false,
        updatedAt: now,
        filePath,
      };
      this.#uploads.set(args.uploadId, entry);
      await writeFile(filePath, chunkBytes, { mode: 0o600 });
    } else {
      if (!entry || entry.from !== from) {
        throw new Error("附件上传会话不存在或已过期，请重试");
      }
      if (entry.ready) {
        throw new Error("附件上传已完成，请勿重复写入");
      }
      if (entry.totalBytes !== args.totalBytes || args.offset !== entry.receivedBytes) {
        throw new Error("附件分块偏移不连续，请重新上传");
      }
      if (entry.receivedBytes + chunkBytes.length > entry.totalBytes) {
        throw new Error("附件数据超过声明大小");
      }
      await appendFile(entry.filePath, chunkBytes);
    }

    entry.receivedBytes += chunkBytes.length;
    entry.updatedAt = now;

    if (entry.receivedBytes > entry.totalBytes) {
      await this.#remove(entry);
      throw new Error("附件数据超过声明大小");
    }
    if (args.final) {
      if (entry.receivedBytes !== entry.totalBytes) {
        await this.#remove(entry);
        throw new Error("附件大小与声明不一致，请重新上传");
      }
      entry.ready = true;
    }

    return {
      uploadId: entry.uploadId,
      receivedBytes: entry.receivedBytes,
      ready: entry.ready,
    };
  }

  async consume(from: string, uploadIds: readonly string[], now: number): Promise<File[]> {
    await this.#prune(now);
    const unique = new Set(uploadIds);
    if (unique.size !== uploadIds.length) {
      throw new Error("附件上传编号重复");
    }
    const entries: StagedUpload[] = [];
    for (const uploadId of uploadIds) {
      const entry = this.#uploads.get(uploadId);
      if (!entry || entry.from !== from || !entry.ready) {
        throw new Error("附件尚未上传完成或已过期，请重试");
      }
      entries.push(entry);
    }
    try {
      const files: File[] = [];
      for (const entry of entries) {
        const bytes = await readFile(entry.filePath);
        if (bytes.length !== entry.totalBytes) {
          throw new Error("附件数据不完整，请重新上传");
        }
        files.push(new File([bytes], entry.name, { type: entry.mimeType }));
      }
      return files;
    } finally {
      for (const entry of entries) {
        await this.#remove(entry);
      }
    }
  }

  async clear(): Promise<void> {
    const all = [...this.#uploads.values()];
    this.#uploads.clear();
    await Promise.allSettled(all.map((entry) => rm(entry.filePath, { force: true })));
  }

  #assertSenderQuota(from: string, nextBytes: number): void {
    let count = 0;
    let total = 0;
    for (const entry of this.#uploads.values()) {
      if (entry.from !== from) continue;
      count += 1;
      total += entry.totalBytes;
    }
    if (count >= MAX_UPLOADS_PER_SENDER || total + nextBytes > MAX_TOTAL_BYTES_PER_SENDER) {
      throw new Error("待保存的附件过多，请稍后再试");
    }
  }

  async #prune(now: number): Promise<void> {
    const expired: StagedUpload[] = [];
    for (const entry of this.#uploads.values()) {
      if (now - entry.updatedAt > STAGING_TTL_MS) {
        expired.push(entry);
      }
    }
    for (const entry of expired) {
      await this.#remove(entry);
    }
  }

  async #remove(entry: StagedUpload): Promise<void> {
    this.#uploads.delete(entry.uploadId);
    await rm(entry.filePath, { force: true }).catch(() => undefined);
  }
}
