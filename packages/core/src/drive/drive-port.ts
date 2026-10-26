export interface DriveEntry {
  id: string;
  path: string;
  mimeType: string;
  size: number;
  createdTime: string;
  modifiedTime: string;
  etag: string;
  md5Checksum: string;
  appProperties: Record<string, string>;
}

export interface DriveObject extends DriveEntry {
  bytes: Buffer;
}

export interface DrivePutInput {
  path: string;
  bytes: Buffer;
  mimeType: string;
  appProperties?: Record<string, string>;
  ifMatch?: string;
}

export interface DriveUpdateOptions {
  ifMatch?: string;
  mimeType?: string;
  appProperties?: Record<string, string>;
}

export interface DriveListQuery {
  prefix?: string;
  appProperty?: { key: string; value: string };
  modifiedAfter?: string;
}

export interface DriveQuota {
  usedBytes: number;
  totalBytes: number;
}

export interface DriveChanges {
  entries: DriveEntry[];
  removedIds: string[];
  /** Next `changes.list` startPageToken. */
  cursor: string;
  reset: boolean;
}

export interface DriveTextQuery {
  text: string;
  /** Only files whose path starts with this prefix are returned. */
  prefix: string;
  limit: number;
}

export interface DrivePort {
  list(query: DriveListQuery): Promise<DriveEntry[]>;
  /** Drive full-text search, newest first. Used to reach sessions this device never downloaded. */
  searchText(query: DriveTextQuery): Promise<DriveEntry[]>;
  /**
   * Drive `changes.list`. Omit `cursor` to snapshot `prefix` and return a
   * startPageToken. Pass the previous cursor to read the increment.
   */
  changes(query: { prefix: string; cursor?: string }): Promise<DriveChanges>;
  /** Current `changes.getStartPageToken` without listing files. */
  startPageToken(): Promise<string>;
  /** Create a new file. A duplicate path gets a new fileId. */
  create(input: DrivePutInput): Promise<DriveEntry>;
  /** Reference name for {@link create}. */
  put(input: DrivePutInput): Promise<DriveEntry>;
  /**
   * Replace bytes of an existing file. `fileId` does not change.
   * A mismatched `ifMatch` etag throws ConflictError (HTTP 412).
   */
  update(
    fileId: string,
    content: Buffer | string,
    options?: DriveUpdateOptions,
  ): Promise<DriveEntry>;
  /** Create or in-place update the canonical file at `path`. */
  upsert(input: DrivePutInput): Promise<DriveEntry>;
  /** Bytes plus etag, md5Checksum, and modifiedTime. */
  read(id: string): Promise<DriveObject>;
  readPath(path: string): Promise<DriveObject | null>;
  findByPath(path: string): Promise<DriveEntry | null>;
  findByAppProperty(key: string, value: string): Promise<DriveEntry[]>;
  /** Create each missing folder along `path`. Returns the leaf folder id. */
  ensureFolder(path: string): Promise<string>;
  /** Change the file name only. `fileId` and parent stay the same. */
  rename(fileId: string, name: string): Promise<DriveEntry>;
  /**
   * Move a file to `path` (parent and, when the basename differs, name).
   * `fileId` stays the same.
   */
  move(id: string, path: string): Promise<DriveEntry>;
  trash(id: string): Promise<void>;
  quota(): Promise<DriveQuota>;
}
