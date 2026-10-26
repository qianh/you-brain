import { posix } from "node:path";

import { YouBrainError } from "../domain/errors.js";
import type {
  DriveChanges,
  DriveEntry,
  DriveListQuery,
  DriveObject,
  DrivePort,
  DrivePutInput,
  DriveQuota,
  DriveTextQuery,
  DriveUpdateOptions,
} from "./drive-port.js";

const inboxPrefix = "inbox/";

function inboxPath(path: string): string {
  const normalized = posix.normalize(path);
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    (normalized !== "inbox" && !normalized.startsWith(inboxPrefix))
  ) {
    throw new YouBrainError(
      "INVALID_INPUT",
      "Session upload is restricted to the Drive inbox",
    );
  }
  if (normalized === "inbox") return path.endsWith("/") ? inboxPrefix : normalized;
  return normalized;
}

export class InboxScopedDrive implements DrivePort {
  readonly #drive: DrivePort;
  readonly #knownIds = new Set<string>();

  constructor(drive: DrivePort) {
    this.#drive = drive;
  }

  #register<Entry extends DriveEntry>(entry: Entry): Entry | null {
    try {
      inboxPath(entry.path);
    } catch {
      return null;
    }
    this.#knownIds.add(entry.id);
    return entry;
  }

  #requireKnown(id: string): void {
    if (!this.#knownIds.has(id)) {
      throw new YouBrainError(
        "INVALID_INPUT",
        "Drive object is outside the session upload inbox",
      );
    }
  }

  async list(query: DriveListQuery): Promise<DriveEntry[]> {
    const prefix = query.prefix ? inboxPath(query.prefix) : inboxPrefix;
    const entries = await this.#drive.list({ ...query, prefix });
    return entries.flatMap((entry) => {
      const registered = this.#register(entry);
      return registered ? [registered] : [];
    });
  }

  async searchText(query: DriveTextQuery): Promise<DriveEntry[]> {
    const prefix = query.prefix ? inboxPath(query.prefix) : inboxPrefix;
    const entries = await this.#drive.searchText({ ...query, prefix });
    return entries.flatMap((entry) => {
      const registered = this.#register(entry);
      return registered ? [registered] : [];
    });
  }

  async changes(query: { prefix: string; cursor?: string }): Promise<DriveChanges> {
    const prefix = query.prefix ? inboxPath(query.prefix) : inboxPrefix;
    const changes = await this.#drive.changes({
      prefix,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    const entries = changes.entries.flatMap((entry) => {
      const registered = this.#register(entry);
      return registered ? [registered] : [];
    });
    for (const id of changes.removedIds) this.#knownIds.delete(id);
    return { ...changes, entries };
  }

  startPageToken(): Promise<string> {
    return this.#drive.startPageToken();
  }

  async create(input: DrivePutInput): Promise<DriveEntry> {
    return this.put(input);
  }

  async put(input: DrivePutInput): Promise<DriveEntry> {
    const entry = await this.#drive.put({
      ...input,
      path: inboxPath(input.path),
    });
    const registered = this.#register(entry);
    if (!registered) {
      throw new YouBrainError("INVALID_INPUT", "Drive returned an object outside inbox");
    }
    return registered;
  }

  async update(
    fileId: string,
    content: Buffer | string,
    options?: DriveUpdateOptions,
  ): Promise<DriveEntry> {
    this.#requireKnown(fileId);
    const entry = await this.#drive.update(fileId, content, options);
    const registered = this.#register(entry);
    if (!registered) {
      throw new YouBrainError("INVALID_INPUT", "Drive returned an object outside inbox");
    }
    return registered;
  }

  async upsert(input: DrivePutInput): Promise<DriveEntry> {
    const entry = await this.#drive.upsert({
      ...input,
      path: inboxPath(input.path),
    });
    const registered = this.#register(entry);
    if (!registered) {
      throw new YouBrainError("INVALID_INPUT", "Drive returned an object outside inbox");
    }
    return registered;
  }

  async read(id: string): Promise<DriveObject> {
    const object = await this.#drive.read(id);
    const registered = this.#register(object);
    if (!registered) {
      throw new YouBrainError("INVALID_INPUT", "Drive returned an object outside inbox");
    }
    return registered;
  }

  async readPath(path: string): Promise<DriveObject | null> {
    const object = await this.#drive.readPath(inboxPath(path));
    if (!object) return null;
    const registered = this.#register(object);
    if (!registered) {
      throw new YouBrainError("INVALID_INPUT", "Drive returned an object outside inbox");
    }
    return registered;
  }

  async findByPath(path: string): Promise<DriveEntry | null> {
    const entry = await this.#drive.findByPath(inboxPath(path));
    if (!entry) return null;
    const registered = this.#register(entry);
    if (!registered) {
      throw new YouBrainError("INVALID_INPUT", "Drive returned an object outside inbox");
    }
    return registered;
  }

  async findByAppProperty(key: string, value: string): Promise<DriveEntry[]> {
    return this.list({ appProperty: { key, value } });
  }

  async ensureFolder(path: string): Promise<string> {
    return this.#drive.ensureFolder(inboxPath(path));
  }

  async rename(fileId: string, name: string): Promise<DriveEntry> {
    this.#requireKnown(fileId);
    const entry = await this.#drive.rename(fileId, name);
    const registered = this.#register(entry);
    if (!registered) {
      throw new YouBrainError("INVALID_INPUT", "Drive returned an object outside inbox");
    }
    return registered;
  }

  async move(id: string, path: string): Promise<DriveEntry> {
    this.#requireKnown(id);
    const entry = await this.#drive.move(id, inboxPath(path));
    const registered = this.#register(entry);
    if (!registered) {
      throw new YouBrainError("INVALID_INPUT", "Drive returned an object outside inbox");
    }
    return registered;
  }

  async trash(id: string): Promise<void> {
    this.#requireKnown(id);
    await this.#drive.trash(id);
    this.#knownIds.delete(id);
  }

  quota(): Promise<DriveQuota> {
    return this.#drive.quota();
  }
}
