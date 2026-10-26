import { createHash } from "node:crypto";

import type {
  SearchDrive,
  SearchDriveChanges,
  SearchDriveEntry,
  SearchDriveObject,
} from "../../src/search/drive.js";

interface StoredObject extends SearchDriveObject {
  id: string;
  path: string;
  mimeType: string;
  trashed: boolean;
}

export class MemoryDrive implements SearchDrive {
  readonly #objects = new Map<string, StoredObject>();
  #counter = 0;
  #changeCounter = 0;
  readonly #changes: Array<{ sequence: number; id: string }> = [];
  #failChanges = false;

  failChanges(failed: boolean): void {
    this.#failChanges = failed;
  }

  #recordChange(id: string): void {
    this.#changeCounter += 1;
    this.#changes.push({ sequence: this.#changeCounter, id });
  }

  #entry(object: StoredObject): SearchDriveEntry {
    return { id: object.id, path: object.path, mimeType: object.mimeType };
  }

  list(query: { prefix?: string } = {}): SearchDriveEntry[] {
    return [...this.#objects.values()]
      .filter((object) => !object.trashed)
      .filter((object) => !query.prefix || object.path.startsWith(query.prefix))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((object) => this.#entry(object));
  }

  searchText(query: { text: string; prefix: string; limit: number }): Promise<SearchDriveEntry[]> {
    this.searches.push(query.text);
    const terms = query.text.toLowerCase().split(/\s+/u).filter(Boolean);
    return Promise.resolve(
      [...this.#objects.values()]
        .filter((object) => !object.trashed && object.path.startsWith(query.prefix))
        .filter((object) => {
          const text = new TextDecoder().decode(object.bytes).toLowerCase();
          return terms.every((term) => text.includes(term));
        })
        .slice(0, query.limit)
        .map((object) => this.#entry(object)),
    );
  }

  readonly searches: string[] = [];

  async put(input: {
    path: string;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<SearchDriveEntry> {
    const id = `file-${String(++this.#counter).padStart(8, "0")}`;
    const object: StoredObject = {
      id,
      path: input.path,
      bytes: new Uint8Array(input.bytes),
      mimeType: input.mimeType,
      trashed: false,
    };
    this.#objects.set(id, object);
    this.#recordChange(id);
    return this.#entry(object);
  }

  async upsert(input: {
    path: string;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<SearchDriveEntry> {
    const existing = [...this.#objects.values()].find(
      (object) => !object.trashed && object.path === input.path,
    );
    const id = existing?.id ?? `file-${String(++this.#counter).padStart(8, "0")}`;
    const object: StoredObject = {
      id,
      path: input.path,
      bytes: new Uint8Array(input.bytes),
      mimeType: input.mimeType,
      trashed: false,
    };
    this.#objects.set(id, object);
    this.#recordChange(id);
    return this.#entry(object);
  }

  async changes(query: {
    prefix: string;
    cursor?: string;
  }): Promise<SearchDriveChanges> {
    if (this.#failChanges) throw new Error("offline");
    if (query.cursor === undefined) {
      return {
        entries: this.list({ prefix: query.prefix }),
        removedIds: [],
        cursor: String(this.#changeCounter),
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
    const entries: SearchDriveEntry[] = [];
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
      cursor: String(this.#changeCounter),
      reset: false,
    };
  }

  async read(id: string): Promise<SearchDriveObject> {
    const object = this.#objects.get(id);
    if (!object || object.trashed) {
      throw new Error(`Drive object not found: ${id}`);
    }
    return { bytes: new Uint8Array(object.bytes) };
  }
}

export function contentSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
