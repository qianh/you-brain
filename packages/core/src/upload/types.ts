import type { DriveEntry } from "../drive/drive-port.js";

/** Local map from conversationKey to the stable Drive file. */
export interface UploadRecordMeta {
  path: string;
  etag: string;
  md5Checksum: string;
  contentSha256: string;
  updatedAt: string;
  messageCount: number;
}

export interface UploadIndex {
  fileIdOf(key: string): string | null | Promise<string | null>;
  record(
    key: string,
    fileId: string,
    meta: UploadRecordMeta,
  ): void | Promise<void>;
}

/**
 * One session ready to upload. Markdown is already rendered (capture owns the
 * BrainHub byte format). `messageCount` is the visible turn count.
 */
export interface UploadableSession {
  source: string;
  conversationId: string;
  device: string;
  title?: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  markdown: string;
  contentSha256?: string;
}

/**
 * Feed of sessions for UploadService.uploadSource.
 * Not the capture source id from domain.
 */
export interface SessionSource {
  listSessions(): Promise<readonly UploadableSession[]> | readonly UploadableSession[];
}

export interface UploadResult {
  key: string;
  fileId: string;
  path: string;
  etag: string;
  md5Checksum: string;
  action: "created" | "updated" | "unchanged";
  renamed: boolean;
  trashedIds: string[];
}

export interface UploadWaiting {
  status: "waiting";
  key: string;
  due: false;
  reason: "idle" | "active" | "waiting";
  waitMs: number;
}

export interface UploadCompleted {
  status: "uploaded";
  result: UploadResult;
}

export type UploadAttempt = UploadWaiting | UploadCompleted;

export interface JsonUpdateResult<T> {
  file: DriveEntry;
  value: T;
}
