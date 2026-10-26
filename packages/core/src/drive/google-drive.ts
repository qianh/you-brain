import { Readable } from "node:stream";
import { posix } from "node:path";

import type { drive_v3 } from "googleapis";

import { YouBrainError } from "../domain/errors.js";
import { ConflictError, isConflict } from "./errors.js";
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

/** Folders listed at the same time while walking a tree. */
const WALK_CONCURRENCY = 8;
const folderMimeType = "application/vnd.google-apps.folder";
const googleDocumentMimeType = "application/vnd.google-apps.document";
/** Other devices can rename or move folders, so cached levels expire on their own too. */
const FOLDER_CACHE_TTL_MS = 60_000;
/**
 * gaxios aborts the request, but on Bun a body that stalls after the headers
 * still never settles. Cap every resource call so one hang cannot block the tick.
 */
const DEFAULT_REQUEST_DEADLINE_MS = 120_000;
const fileFields =
  "id,name,mimeType,parents,size,createdTime,modifiedTime,md5Checksum,appProperties,version,trashed";

export class DriveRootConflictError extends YouBrainError {
  constructor(readonly candidates: string[]) {
    super(
      "DRIVE_ROOT_CONFLICT",
      `Multiple brain-hub folders exist; choose one of: ${candidates.join(", ")}`,
    );
  }
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = (getter as (key: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

function isMissingOrOutsideRoot(error: unknown): boolean {
  return (
    (error instanceof YouBrainError && error.code === "INVALID_INPUT") ||
    (error as { code?: unknown } | null)?.code === 404
  );
}

function folderSignature(file: drive_v3.Schema$File): string {
  return `${file.name ?? ""}\u0000${file.parents?.[0] ?? ""}`;
}

function asBuffer(content: Buffer | string): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

export class DriveRequestTimeoutError extends Error {
  readonly code = "DRIVE_REQUEST_TIMEOUT" as const;

  constructor(method: string) {
    super(`Google Drive request timed out: ${method}`);
    this.name = "DriveRequestTimeoutError";
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function raceDeadline<T>(pending: Promise<T>, method: string, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new DriveRequestTimeoutError(method));
    }, deadlineMs);
    timer.unref();
  });
  return Promise.race([pending, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

const DEADLINE_RESOURCES = ["files", "changes", "about"] as const;

function methodNames(resource: object): string[] {
  const names = new Set<string>();
  for (let node: object | null = resource; node && node !== Object.prototype; node = Object.getPrototypeOf(node)) {
    for (const name of Object.getOwnPropertyNames(node)) {
      if (name !== "constructor" && typeof (resource as Record<string, unknown>)[name] === "function") {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Gives every promise method of the Drive resources a deadline. Methods are wrapped one by
 * one; a `Proxy` would break on googleapis resources, which have frozen properties.
 */
function withRequestDeadlines<T extends object>(client: T, deadlineMs: number): T {
  const wrapped = Object.create(client) as Record<string, unknown>;
  for (const key of DEADLINE_RESOURCES) {
    const resource = (client as Record<string, unknown>)[key];
    if (resource === null || typeof resource !== "object") continue;
    const guarded: Record<string, unknown> = {};
    for (const name of methodNames(resource)) {
      guarded[name] = (...args: unknown[]) => {
        const result = ((resource as Record<string, (...args: unknown[]) => unknown>)[name] as (...args: unknown[]) => unknown).apply(resource, args);
        return isPromiseLike(result) ? raceDeadline(result, `${key}.${name}`, deadlineMs) : result;
      };
    }
    Object.defineProperty(wrapped, key, { value: guarded, enumerable: true });
  }
  return wrapped as T;
}

export class GoogleDrive implements DrivePort {
  readonly #client: drive_v3.Drive;
  readonly #rootFolderId: string;
  readonly #folderCreations = new Map<string, Promise<string>>();
  readonly #now: () => number;
  /** Folder ids per intermediate directory path. The last path segment is never cached. */
  readonly #folderCache = new Map<string, { ids: string[]; at: number }>();
  /** Name and parent per folder id, so resolving a path costs a request per new folder, not per file. */
  readonly #folderInfo = new Map<string, { name: string | null; parents: string[]; at: number }>();
  /**
   * Name and parent each folder last had, from walks and from the change feed. A folder
   * shows up in the feed whenever a file is added to it, so only a different name or
   * parent means the tree changed.
   */
  readonly #folderSeen = new Map<string, string>();
  /** Bumped on every folder change so a resolve that started earlier does not refill the cache. */
  #folderGeneration = 0;

  constructor(options: {
    client: drive_v3.Drive;
    rootFolderId: string;
    now?: () => number;
    requestDeadlineMs?: number;
  }) {
    if (!options.rootFolderId) {
      throw new YouBrainError(
        "DRIVE_ROOT_REQUIRED",
        "Drive root folder is not configured",
      );
    }
    this.#client = withRequestDeadlines(
      options.client,
      options.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS,
    );
    this.#rootFolderId = options.rootFolderId;
    this.#now = options.now ?? Date.now;
  }

  static async openMyDrive(client: drive_v3.Drive): Promise<GoogleDrive> {
    const response = await client.files.get({
      fileId: "root",
      fields: "id",
      supportsAllDrives: true,
    });
    if (!response.data.id) {
      throw new YouBrainError(
        "DRIVE_ROOT_REQUIRED",
        "Google Drive did not return the My Drive root ID",
      );
    }
    return new GoogleDrive({ client, rootFolderId: response.data.id });
  }

  static async createRoot(
    client: drive_v3.Drive,
    name: string,
    selectedId?: string,
  ): Promise<string> {
    const q = `'root' in parents and name = '${escapeQuery(name)}' and mimeType = '${folderMimeType}' and trashed = false`;
    const existing = await client.files.list({
      q,
      fields: "files(id)",
      pageSize: 1_000,
      spaces: "drive",
    });
    const candidates = (existing.data.files ?? [])
      .flatMap((file) => (file.id ? [file.id] : []))
      .sort();
    if (selectedId) {
      if (candidates.includes(selectedId)) return selectedId;
      throw new YouBrainError(
        "INVALID_INPUT",
        `Selected Drive root ${selectedId} is not a matching ${name} folder`,
      );
    }
    if (candidates.length > 1) throw new DriveRootConflictError(candidates);
    if (candidates[0]) return candidates[0];
    const created = await client.files.create({
      requestBody: { name, mimeType: folderMimeType, parents: ["root"] },
      fields: "id",
    });
    if (!created.data.id) {
      throw new Error("Google Drive did not return a root folder ID");
    }
    return created.data.id;
  }

  async #metadataResponse(id: string) {
    return this.#client.files.get({
      fileId: id,
      fields: fileFields,
      supportsAllDrives: true,
    });
  }

  async #metadata(id: string): Promise<drive_v3.Schema$File> {
    return (await this.#metadataResponse(id)).data;
  }

  /** Name and parent of an ancestor folder. Cached briefly: other devices can rename or move it. */
  async #ancestor(id: string): Promise<{ name?: string | null; parents?: string[] | null }> {
    const cached = this.#folderInfo.get(id);
    if (cached && this.#now() - cached.at < FOLDER_CACHE_TTL_MS) return cached;
    const generation = this.#folderGeneration;
    const file = await this.#metadata(id);
    const info = { name: file.name ?? null, parents: file.parents ?? [], at: this.#now() };
    if (generation === this.#folderGeneration) this.#folderInfo.set(id, info);
    return info;
  }

  async #assertDescendant(id: string): Promise<void> {
    let current = id;
    const visited = new Set<string>();
    while (current !== this.#rootFolderId) {
      if (visited.has(current)) throw new Error("Drive parent cycle detected");
      const first = visited.size === 0;
      visited.add(current);
      // The object itself is read fresh; only the folders above it come from the cache.
      const metadata = first ? await this.#metadata(current) : await this.#ancestor(current);
      const parent = metadata.parents?.[0];
      if (!parent) {
        throw new YouBrainError(
          "INVALID_INPUT",
          "Drive object is outside the BrainHub root",
        );
      }
      current = parent;
    }
  }

  async #children(parentId: string): Promise<drive_v3.Schema$File[]> {
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.#client.files.list({
        q: `'${escapeQuery(parentId)}' in parents and trashed = false`,
        fields: `nextPageToken,files(${fileFields})`,
        pageSize: 1_000,
        ...(pageToken ? { pageToken } : {}),
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      files.push(...(response.data.files ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return files;
  }

  async #namedChildren(
    parentId: string,
    name: string,
  ): Promise<drive_v3.Schema$File[]> {
    const files: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.#client.files.list({
        q: `'${escapeQuery(parentId)}' in parents and name = '${escapeQuery(name)}' and trashed = false`,
        fields: `nextPageToken,files(${fileFields})`,
        pageSize: 1_000,
        ...(pageToken ? { pageToken } : {}),
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      files.push(...(response.data.files ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return files
      .filter((file) => file.name === name)
      .sort((left, right) => String(right.id).localeCompare(String(left.id)));
  }

  async #resolveAll(path: string): Promise<drive_v3.Schema$File[]> {
    const segments = safePath(path).split("/");
    const generation = this.#folderGeneration;
    let parentIds = [this.#rootFolderId];
    let found: drive_v3.Schema$File[] = [];
    let prefix = "";
    for (const [index, segment] of segments.entries()) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const intermediate = index < segments.length - 1;
      const cached = intermediate ? this.#cachedFolders(prefix) : undefined;
      if (cached) {
        parentIds = cached;
        continue;
      }
      found = (
        await Promise.all(
          parentIds.map((parentId) => this.#namedChildren(parentId, segment)),
        )
      ).flat();
      if (intermediate) {
        found = found.filter((file) => file.mimeType === folderMimeType);
      }
      const unique = new Map(
        found.filter((file) => file.id).map((file) => [file.id as string, file]),
      );
      found = [...unique.values()];
      parentIds = [...unique.keys()];
      if (parentIds.length === 0) return [];
      if (intermediate && generation === this.#folderGeneration) {
        this.#folderCache.set(prefix, { ids: parentIds, at: this.#now() });
      }
    }
    return found;
  }

  #cachedFolders(prefix: string): string[] | undefined {
    const entry = this.#folderCache.get(prefix);
    if (!entry) return undefined;
    if (this.#now() - entry.at >= FOLDER_CACHE_TTL_MS) {
      this.#folderCache.delete(prefix);
      return undefined;
    }
    return entry.ids;
  }

  /** Any folder create, rename, move, or trash clears every cached level. */
  #forgetFolders(): void {
    this.#folderGeneration += 1;
    this.#folderCache.clear();
    this.#folderInfo.clear();
  }

  async ensureFolder(path: string): Promise<string> {
    if (!path) return this.#rootFolderId;
    const normalized = safePath(path);
    let parent = this.#rootFolderId;
    let currentPath = "";
    for (const segment of normalized.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let creation = this.#folderCreations.get(currentPath);
      if (!creation) {
        const parentId = parent;
        creation = this.#findOrCreateFolder(parentId, segment);
        this.#folderCreations.set(currentPath, creation);
      }
      try {
        parent = await creation;
      } finally {
        if (this.#folderCreations.get(currentPath) === creation) {
          this.#folderCreations.delete(currentPath);
        }
      }
    }
    return parent;
  }

  async #findOrCreateFolder(parent: string, name: string): Promise<string> {
    const child = (await this.#children(parent)).find(
      (file) => file.name === name && file.mimeType === folderMimeType,
    );
    if (child?.id) return child.id;
    const created = await this.#client.files.create({
      requestBody: {
        name,
        mimeType: folderMimeType,
        parents: [parent],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    if (!created.data.id) {
      throw new Error("Google Drive did not return a folder ID");
    }
    this.#forgetFolders();
    return created.data.id;
  }

  #etagOf(file: drive_v3.Schema$File, headers: unknown): string {
    return headerValue(headers, "etag") ?? String(file.version ?? "");
  }

  #entry(
    file: drive_v3.Schema$File,
    path: string,
    etag: string | undefined = undefined,
  ): DriveEntry {
    if (!file.id) throw new Error("Google Drive file is missing an ID");
    return {
      id: file.id,
      path,
      mimeType: file.mimeType ?? "application/octet-stream",
      size: Number(file.size ?? 0),
      createdTime: file.createdTime ?? file.modifiedTime ?? new Date(0).toISOString(),
      modifiedTime: file.modifiedTime ?? new Date(0).toISOString(),
      etag: etag ?? String(file.version ?? ""),
      md5Checksum: file.md5Checksum ?? "",
      appProperties: file.appProperties ?? {},
    };
  }

  async #walkFrom(
    rootId: string,
    rootPath: string,
  ): Promise<Array<{ file: drive_v3.Schema$File; path: string }>> {
    const output: Array<{ file: drive_v3.Schema$File; path: string }> = [];
    // Level by level, a few folders at a time. A tree of hundreds of folders costs one
    // round trip per folder, so a serial walk takes minutes. Result order is unchanged.
    let level: Array<{ id: string; path: string }> = [{ id: rootId, path: rootPath }];
    while (level.length > 0) {
      const next: Array<{ id: string; path: string }> = [];
      for (let start = 0; start < level.length; start += WALK_CONCURRENCY) {
        const batch = level.slice(start, start + WALK_CONCURRENCY);
        const listed = await Promise.all(
          batch.map(async (current) => ({ current, children: await this.#children(current.id) })),
        );
        for (const { current, children } of listed) {
          for (const file of children) {
            if (!file.id || !file.name) continue;
            const path = current.path ? `${current.path}/${file.name}` : file.name;
            if (file.mimeType === folderMimeType) {
              this.#folderSeen.set(file.id, folderSignature(file));
              next.push({ id: file.id, path });
            } else output.push({ file, path });
          }
        }
      }
      level = next;
    }
    return output;
  }

  async #walk(): Promise<Array<{ file: drive_v3.Schema$File; path: string }>> {
    return this.#walkFrom(this.#rootFolderId, "");
  }

  async list(query: DriveListQuery): Promise<DriveEntry[]> {
    if (query.prefix) safePath(query.prefix.replace(/\/$/u, "") || "invalid");
    let files: Array<{ file: drive_v3.Schema$File; path: string }>;
    // One query finds the matches; the prefix filter below keeps only those under it.
    // Walking the prefix tree instead costs a request per folder on every call.
    if (query.appProperty) {
      const { key, value } = query.appProperty;
      const response = await this.#client.files.list({
        q: `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' } and trashed = false`,
        fields: `files(${fileFields})`,
        pageSize: 1_000,
        spaces: "drive",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      files = [];
      for (const file of response.data.files ?? []) {
        if (!file.id) continue;
        try {
          await this.#assertDescendant(file.id);
        } catch {
          continue;
        }
        files.push({ file, path: await this.#pathFor(file.id) });
      }
    } else if (query.prefix) {
      const prefix = query.prefix.replace(/\/$/u, "");
      const roots = await this.#resolveAll(prefix);
      if (roots.length === 0) return [];
      files = (
        await Promise.all(
          roots.map((root) =>
            root.id && root.mimeType === folderMimeType
              ? this.#walkFrom(root.id, prefix)
              : Promise.resolve([{ file: root, path: prefix }]),
          ),
        )
      ).flat();
    } else {
      files = await this.#walk();
    }
    return files
      .filter(({ path }) => !query.prefix || path.startsWith(query.prefix))
      .filter(
        ({ file }) =>
          !query.appProperty ||
          file.appProperties?.[query.appProperty.key] === query.appProperty.value,
      )
      .filter(
        ({ file }) =>
          !query.modifiedAfter || (file.modifiedTime ?? "") > query.modifiedAfter,
      )
      .map(({ file, path }) => this.#entry(file, path));
  }

  async searchText(query: DriveTextQuery): Promise<DriveEntry[]> {
    const prefix = safePath(query.prefix.replace(/\/$/u, "") || "invalid");
    const response = await this.#client.files.list({
      q: `fullText contains '${escapeQuery(query.text)}' and mimeType != '${folderMimeType}' and trashed = false`,
      fields: `files(${fileFields})`,
      orderBy: "modifiedTime desc",
      pageSize: 50,
      spaces: "drive",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    const entries: DriveEntry[] = [];
    for (const file of response.data.files ?? []) {
      if (entries.length >= query.limit) break;
      if (!file.id) continue;
      let path: string;
      try {
        path = await this.#pathFor(file.id, file);
      } catch {
        continue;
      }
      if (path.startsWith(`${prefix}/`)) entries.push(this.#entry(file, path));
    }
    return entries;
  }

  async startPageToken(): Promise<string> {
    const token = await this.#client.changes.getStartPageToken({
      supportsAllDrives: true,
    });
    if (!token.data.startPageToken) {
      throw new Error("Google Drive did not return a change cursor");
    }
    return token.data.startPageToken;
  }

  async changes(query: { prefix: string; cursor?: string }): Promise<DriveChanges> {
    const prefix = safePath(query.prefix.replace(/\/$/u, "") || "invalid");
    const normalizedPrefix = `${prefix}/`;
    if (query.cursor === undefined) {
      return {
        entries: await this.list({ prefix: normalizedPrefix }),
        removedIds: [],
        cursor: await this.startPageToken(),
        reset: true,
      };
    }

    const entries = new Map<string, DriveEntry>();
    const removedIds = new Set<string>();
    let pageToken: string | undefined = query.cursor;
    let cursor = query.cursor;
    let requiresReset = false;
    try {
      do {
        const response: {
          data: {
            changes?: drive_v3.Schema$Change[];
            nextPageToken?: string | null;
            newStartPageToken?: string | null;
          };
        } = await this.#client.changes.list({
          ...(pageToken !== undefined ? { pageToken } : {}),
          fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${fileFields}))`,
          pageSize: 1_000,
          spaces: "drive",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
        for (const change of response.data.changes ?? []) {
          const id = change.fileId ?? change.file?.id;
          if (!id) continue;
          if (change.file?.mimeType === folderMimeType) {
            const folder = change.file;
            if (change.removed || folder.trashed) {
              requiresReset = true;
              continue;
            }
            const signature = folderSignature(folder);
            const known = this.#folderSeen.get(id);
            if (known === signature) continue;
            this.#folderSeen.set(id, signature);
            if (known !== undefined) {
              // Renamed or moved: every path under it changed.
              requiresReset = true;
              continue;
            }
            // Not seen before: created, or moved in from elsewhere. List just this subtree.
            try {
              const path = await this.#pathFor(id, folder);
              if (`${path}/`.startsWith(normalizedPrefix)) {
                for (const found of await this.#walkFrom(id, path)) {
                  entries.set(found.file.id ?? "", this.#entry(found.file, found.path));
                  removedIds.delete(found.file.id ?? "");
                }
              } else if (normalizedPrefix.startsWith(`${path}/`)) {
                requiresReset = true;
              }
            } catch (error) {
              if (!isMissingOrOutsideRoot(error)) throw error;
            }
            continue;
          }
          if (change.removed || change.file?.trashed) {
            entries.delete(id);
            removedIds.add(id);
            continue;
          }
          try {
            const path = await this.#pathFor(id, change.file ?? undefined);
            if (!path.startsWith(normalizedPrefix)) {
              entries.delete(id);
              removedIds.add(id);
              continue;
            }
            const metadata = change.file ?? (await this.#metadata(id));
            entries.set(id, this.#entry(metadata, path));
            removedIds.delete(id);
          } catch (error) {
            if (!isMissingOrOutsideRoot(error)) throw error;
            entries.delete(id);
            removedIds.add(id);
          }
        }
        pageToken = response.data.nextPageToken ?? undefined;
        cursor = response.data.newStartPageToken ?? pageToken ?? cursor;
      } while (pageToken);
    } catch (error) {
      if ((error as { code?: unknown }).code === 410) {
        return this.changes({ prefix: normalizedPrefix });
      }
      throw error;
    }
    if (requiresReset) {
      return {
        entries: await this.list({ prefix: normalizedPrefix }),
        removedIds: [],
        cursor,
        reset: true,
      };
    }
    return {
      entries: [...entries.values()].sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
      removedIds: [...removedIds].sort(),
      cursor,
      reset: false,
    };
  }

  /** `known` is the object's own metadata when the caller already has it (a change feed entry). */
  async #pathFor(id: string, known?: drive_v3.Schema$File): Promise<string> {
    const segments: string[] = [];
    let current = id;
    let first = true;
    while (current !== this.#rootFolderId) {
      const file = first ? (known ?? (await this.#metadata(current))) : await this.#ancestor(current);
      const name = file.name;
      const parent = file.parents?.[0];
      if (!name || !parent) {
        throw new YouBrainError(
          "INVALID_INPUT",
          "Drive object is outside the BrainHub root",
        );
      }
      segments.unshift(name);
      current = parent;
      first = false;
    }
    return segments.join("/");
  }

  async create(input: DrivePutInput): Promise<DriveEntry> {
    return this.put(input);
  }

  async put(input: DrivePutInput): Promise<DriveEntry> {
    const path = safePath(input.path);
    const parent = await this.ensureFolder(
      posix.dirname(path) === "." ? "" : posix.dirname(path),
    );
    const response = await this.#client.files.create({
      requestBody: {
        name: posix.basename(path),
        parents: [parent],
        ...(input.appProperties ? { appProperties: input.appProperties } : {}),
      },
      media: { mimeType: input.mimeType, body: Readable.from(input.bytes) },
      fields: fileFields,
      supportsAllDrives: true,
    });
    return this.#entry(
      response.data,
      path,
      headerValue(response.headers, "etag"),
    );
  }

  async update(
    fileId: string,
    content: Buffer | string,
    options?: DriveUpdateOptions,
  ): Promise<DriveEntry> {
    await this.#assertDescendant(fileId);
    const bytes = asBuffer(content);
    const current = await this.#metadataResponse(fileId);
    const currentEtag = this.#etagOf(current.data, current.headers);
    if (options?.ifMatch !== undefined && options.ifMatch !== currentEtag) {
      throw new ConflictError();
    }
    const mimeType =
      options?.mimeType ?? current.data.mimeType ?? "application/octet-stream";
    const request = {
      fileId,
      requestBody: options?.appProperties
        ? { appProperties: options.appProperties }
        : {},
      media: { mimeType, body: Readable.from(bytes) },
      fields: fileFields,
      supportsAllDrives: true,
    };
    try {
      const response =
        options?.ifMatch !== undefined
          ? await this.#client.files.update(request, {
              headers: { "If-Match": options.ifMatch },
            })
          : await this.#client.files.update(request);
      const path = await this.#pathFor(fileId);
      return this.#entry(
        response.data,
        path,
        headerValue(response.headers, "etag"),
      );
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      if (isConflict(error)) throw new ConflictError();
      throw error;
    }
  }

  async upsert(input: DrivePutInput): Promise<DriveEntry> {
    const path = safePath(input.path);
    const existing = await this.findByPath(path);
    if (!existing) {
      if (input.ifMatch !== undefined) throw new ConflictError();
      return this.put(input);
    }
    const options: DriveUpdateOptions = { mimeType: input.mimeType };
    if (input.ifMatch !== undefined) options.ifMatch = input.ifMatch;
    if (input.appProperties) options.appProperties = input.appProperties;
    return this.update(existing.id, input.bytes, options);
  }

  async read(id: string): Promise<DriveObject> {
    await this.#assertDescendant(id);
    const metadata = await this.#metadataResponse(id);
    const content =
      metadata.data.mimeType === googleDocumentMimeType
        ? await this.#client.files.export(
            { fileId: id, mimeType: "text/markdown" },
            { responseType: "arraybuffer" },
          )
        : await this.#client.files.get(
            { fileId: id, alt: "media", supportsAllDrives: true },
            { responseType: "arraybuffer" },
          );
    const path = await this.#pathFor(id);
    return {
      ...this.#entry(metadata.data, path, headerValue(metadata.headers, "etag")),
      bytes: Buffer.from(content.data as ArrayBuffer),
    };
  }

  async readPath(path: string): Promise<DriveObject | null> {
    const entry = await this.findByPath(path);
    return entry ? this.read(entry.id) : null;
  }

  async findByPath(path: string): Promise<DriveEntry | null> {
    const normalized = safePath(path);
    const found = (await this.#resolveAll(normalized))
      .filter(
        (file) =>
          file.id && file.mimeType !== folderMimeType && file.trashed !== true,
      )
      .sort((left, right) => {
        const created = (left.createdTime ?? left.modifiedTime ?? "").localeCompare(
          right.createdTime ?? right.modifiedTime ?? "",
        );
        if (created !== 0) return created;
        return String(left.id).localeCompare(String(right.id));
      });
    const file = found[0];
    if (!file?.id) return null;
    return this.#entry(file, normalized);
  }

  findByAppProperty(key: string, value: string): Promise<DriveEntry[]> {
    return this.list({ appProperty: { key, value } });
  }

  async rename(fileId: string, name: string): Promise<DriveEntry> {
    const nextName = safeName(name);
    await this.#assertDescendant(fileId);
    const response = await this.#client.files.update({
      fileId,
      requestBody: { name: nextName },
      fields: fileFields,
      supportsAllDrives: true,
    });
    this.#forgetFolders();
    const path = await this.#pathFor(fileId);
    return this.#entry(response.data, path, headerValue(response.headers, "etag"));
  }

  async move(id: string, pathValue: string): Promise<DriveEntry> {
    const path = safePath(pathValue);
    await this.#assertDescendant(id);
    const metadata = await this.#metadata(id);
    const parent = await this.ensureFolder(
      posix.dirname(path) === "." ? "" : posix.dirname(path),
    );
    const response = await this.#client.files.update({
      fileId: id,
      addParents: parent,
      ...(metadata.parents?.length
        ? { removeParents: metadata.parents.join(",") }
        : {}),
      requestBody: { name: posix.basename(path) },
      fields: fileFields,
      supportsAllDrives: true,
    });
    this.#forgetFolders();
    return this.#entry(response.data, path, headerValue(response.headers, "etag"));
  }

  async trash(id: string): Promise<void> {
    await this.#assertDescendant(id);
    await this.#client.files.update({
      fileId: id,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    this.#forgetFolders();
  }

  async quota(): Promise<DriveQuota> {
    const response = await this.#client.about.get({ fields: "storageQuota" });
    return {
      usedBytes: Number(response.data.storageQuota?.usage ?? 0),
      totalBytes: Number(response.data.storageQuota?.limit ?? 0),
    };
  }
}
