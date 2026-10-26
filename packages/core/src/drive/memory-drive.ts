import { createHash } from "node:crypto";
import { posix } from "node:path";

import { ConflictError } from "./errors.js";
import { md5Hex } from "./hash.js";
import { safeName, safePath } from "./path.js";
import type {
  DriveChanges,
  DriveEntry,
  DriveListQuery,
  DriveTextQuery,
  DriveObject,
  DrivePort,
  DrivePutInput,
  DriveQuota,
  DriveUpdateOptions,
} from "./drive-port.js";

interface StoredObject extends DriveObject {
  trashed: boolean;
}

function asBuffer(content: Buffer | string): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

export class MemoryDrive implements DrivePort {
  readonly #objects = new Map<string, StoredObject>();
  readonly #folders = new Map<string, string>();
  readonly #corruptReads: boolean;
  readonly #now: () => Date;
  #counter = 0;
  #version = 0;
  #changeCounter = 0;
  readonly #changes: Array<{ sequence: number; id: string }> = [];

  constructor(options: { corruptReads?: boolean; now?: () => Date } = {}) {
    this.#corruptReads = options.corruptReads ?? false;
    this.#now = options.now ?? (() => new Date());
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #entry(object: StoredObject): DriveEntry {
    return {
      id: object.id,
      path: object.path,
      mimeType: object.mimeType,
      size: object.size,
      createdTime: object.createdTime,
      modifiedTime: object.modifiedTime,
      etag: object.etag,
      md5Checksum: object.md5Checksum,
      appProperties: { ...object.appProperties },
    };
  }

  #nextEtag(bytes: Buffer): string {
    this.#version += 1;
    return createHash("sha256")
      .update(bytes)
      .update(String(this.#version))
      .digest("hex");
  }

  #require(id: string): StoredObject {
    const object = this.#objects.get(id);
    if (!object || object.trashed) {
      throw new Error(`Drive object not found: ${id}`);
    }
    return object;
  }

  #recordChange(id: string): void {
    this.#changeCounter += 1;
    this.#changes.push({ sequence: this.#changeCounter, id });
  }

  #canonical(path: string): StoredObject | undefined {
    const matches = [...this.#objects.values()]
      .filter((object) => !object.trashed && object.path === path)
      .sort(
        (left, right) =>
          left.createdTime.localeCompare(right.createdTime) ||
          left.id.localeCompare(right.id),
      );
    return matches[0];
  }

  async list(query: DriveListQuery): Promise<DriveEntry[]> {
    return [...this.#objects.values()]
      .filter((object) => !object.trashed)
      .filter((object) => !query.prefix || object.path.startsWith(query.prefix))
      .filter(
        (object) =>
          !query.appProperty ||
          object.appProperties[query.appProperty.key] === query.appProperty.value,
      )
      .filter(
        (object) =>
          !query.modifiedAfter || object.modifiedTime > query.modifiedAfter,
      )
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.id.localeCompare(right.id),
      )
      .map((object) => this.#entry(object));
  }

  async searchText(query: DriveTextQuery): Promise<DriveEntry[]> {
    const terms = query.text.toLowerCase().split(/\s+/u).filter(Boolean);
    return [...this.#objects.values()]
      .filter((object) => !object.trashed && object.path.startsWith(query.prefix))
      .filter((object) => {
        const text = object.bytes.toString("utf8").toLowerCase();
        return terms.length > 0 && terms.every((term) => text.includes(term));
      })
      .sort((left, right) => right.modifiedTime.localeCompare(left.modifiedTime))
      .slice(0, query.limit)
      .map((object) => this.#entry(object));
  }

  async startPageToken(): Promise<string> {
    return String(this.#changeCounter);
  }

  async changes(query: { prefix: string; cursor?: string }): Promise<DriveChanges> {
    if (query.cursor === undefined) {
      return {
        entries: await this.list({ prefix: query.prefix }),
        removedIds: [],
        cursor: await this.startPageToken(),
        reset: true,
      };
    }
    const sequence = Number(query.cursor);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new Error("Invalid Drive change cursor");
    }
    const changedIds = new Set(
      this.#changes
        .filter((change) => change.sequence > sequence)
        .map((change) => change.id),
    );
    const entries: DriveEntry[] = [];
    const removedIds: string[] = [];
    for (const id of changedIds) {
      const object = this.#objects.get(id);
      if (object && !object.trashed && object.path.startsWith(query.prefix)) {
        entries.push(this.#entry(object));
      } else {
        removedIds.push(id);
      }
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    removedIds.sort();
    return {
      entries,
      removedIds,
      cursor: await this.startPageToken(),
      reset: false,
    };
  }

  async ensureFolder(path: string): Promise<string> {
    if (!path) return "root";
    const normalized = safePath(path);
    let current = "";
    let id = "root";
    for (const segment of normalized.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      let existing = this.#folders.get(current);
      if (!existing) {
        existing = `folder-${String(++this.#counter).padStart(8, "0")}`;
        this.#folders.set(current, existing);
      }
      id = existing;
    }
    return id;
  }

  async create(input: DrivePutInput): Promise<DriveEntry> {
    return this.put(input);
  }

  async put(input: DrivePutInput): Promise<DriveEntry> {
    const path = safePath(input.path);
    const parent = posix.dirname(path);
    if (parent !== ".") await this.ensureFolder(parent);
    const bytes = Buffer.from(input.bytes);
    const timestamp = this.#timestamp();
    const object: StoredObject = {
      id: `file-${String(++this.#counter).padStart(8, "0")}`,
      path,
      bytes,
      mimeType: input.mimeType,
      size: bytes.length,
      createdTime: timestamp,
      modifiedTime: timestamp,
      etag: this.#nextEtag(bytes),
      md5Checksum: md5Hex(bytes),
      appProperties: { ...input.appProperties },
      trashed: false,
    };
    this.#objects.set(object.id, object);
    this.#recordChange(object.id);
    return this.#entry(object);
  }

  async update(
    fileId: string,
    content: Buffer | string,
    options?: DriveUpdateOptions,
  ): Promise<DriveEntry> {
    const object = this.#require(fileId);
    if (options?.ifMatch !== undefined && options.ifMatch !== object.etag) {
      throw new ConflictError();
    }
    const bytes = asBuffer(content);
    object.bytes = bytes;
    object.size = bytes.length;
    object.modifiedTime = this.#timestamp();
    object.etag = this.#nextEtag(bytes);
    object.md5Checksum = md5Hex(bytes);
    if (options?.mimeType) object.mimeType = options.mimeType;
    if (options?.appProperties) {
      object.appProperties = { ...options.appProperties };
    }
    this.#recordChange(object.id);
    return this.#entry(object);
  }

  async upsert(input: DrivePutInput): Promise<DriveEntry> {
    const path = safePath(input.path);
    const existing = this.#canonical(path);
    if (!existing) {
      if (input.ifMatch !== undefined) throw new ConflictError();
      return this.put({ ...input, path });
    }
    const updateOptions: DriveUpdateOptions = { mimeType: input.mimeType };
    if (input.ifMatch !== undefined) updateOptions.ifMatch = input.ifMatch;
    if (input.appProperties) updateOptions.appProperties = input.appProperties;
    return this.update(existing.id, input.bytes, updateOptions);
  }

  async read(id: string): Promise<DriveObject> {
    const object = this.#require(id);
    const bytes = this.#corruptReads
      ? Buffer.concat([object.bytes, Buffer.from("corrupt")])
      : Buffer.from(object.bytes);
    return { ...this.#entry(object), bytes };
  }

  async readPath(path: string): Promise<DriveObject | null> {
    const entry = await this.findByPath(path);
    return entry ? this.read(entry.id) : null;
  }

  async findByPath(path: string): Promise<DriveEntry | null> {
    const object = this.#canonical(safePath(path));
    return object ? this.#entry(object) : null;
  }

  async findByAppProperty(key: string, value: string): Promise<DriveEntry[]> {
    return this.list({ appProperty: { key, value } });
  }

  async rename(fileId: string, name: string): Promise<DriveEntry> {
    const object = this.#require(fileId);
    const nextName = safeName(name);
    const parent = posix.dirname(object.path);
    object.path = parent === "." ? nextName : `${parent}/${nextName}`;
    object.modifiedTime = this.#timestamp();
    object.etag = this.#nextEtag(object.bytes);
    this.#recordChange(object.id);
    return this.#entry(object);
  }

  async move(id: string, path: string): Promise<DriveEntry> {
    const object = this.#require(id);
    const nextPath = safePath(path);
    const parent = posix.dirname(nextPath);
    if (parent !== ".") await this.ensureFolder(parent);
    object.path = nextPath;
    object.modifiedTime = this.#timestamp();
    this.#recordChange(object.id);
    return this.#entry(object);
  }

  async trash(id: string): Promise<void> {
    const object = this.#objects.get(id);
    if (object) {
      object.trashed = true;
      this.#recordChange(object.id);
    }
  }

  async quota(): Promise<DriveQuota> {
    const usedBytes = [...this.#objects.values()]
      .filter((object) => !object.trashed)
      .reduce((sum, object) => sum + object.size, 0);
    return { usedBytes, totalBytes: 15 * 1024 ** 3 };
  }
}
