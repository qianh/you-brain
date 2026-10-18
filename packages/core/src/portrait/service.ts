import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { writeFileAtomic } from "../domain/atomic.js";
import { YouBrainError } from "../domain/errors.js";
import type { YouBrainPaths } from "../domain/paths.js";
import { portraitFile } from "../domain/paths.js";
import { md5Hex } from "../drive/hash.js";
import type { DriveEntry, DrivePort } from "../drive/drive-port.js";
import type { PortraitRecord } from "../store/types.js";
import type { PortraitConsentStore } from "./consent.js";
import { CodingInjection, type InjectionSyncResult } from "./injection.js";
import { decodePortraitMeta, encodePortraitMeta } from "./meta.js";
import { globPrefix, globToRegExp, resolveDrivePath } from "./path.js";

export interface PortraitVariantConfig {
  id: string;
  path: string;
}

export interface PortraitConfig {
  variants: readonly PortraitVariantConfig[];
  snapshotPattern: string;
}

export interface PortraitStore {
  getPortrait(variant: string): PortraitRecord | null;
  upsertPortrait(record: PortraitRecord): void;
}

export interface PortraitSnapshot {
  fileId: string;
  path: string;
  name: string;
  modifiedTime: string;
  md5: string;
  size: number;
}

export interface PortraitVariantResult {
  id: string;
  status: "written" | "skipped" | "missing";
  localPath: string;
  drivePath: string;
  fileId?: string;
}

export interface PortraitPullResult {
  variants: PortraitVariantResult[];
  injection: InjectionSyncResult;
}

export interface PortraitDocument {
  variant: string;
  portrait: string;
  path: string;
}

export interface PortraitServiceOptions {
  drive: DrivePort;
  store: PortraitStore;
  paths: YouBrainPaths;
  config: PortraitConfig;
  driveRoot?: string;
  consent?: PortraitConsentStore;
  homeDir?: string;
  managedStatePath?: string;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isoTime(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new YouBrainError("INVALID_INPUT", "Drive modifiedTime is not a timestamp");
  }
  return new Date(ms).toISOString();
}

function idleInjection(): InjectionSyncResult {
  return { updated: false, applied: [], skipped: [] };
}

export class PortraitService {
  readonly #drive: DrivePort;
  readonly #store: PortraitStore;
  readonly #paths: YouBrainPaths;
  readonly #driveRoot: string;
  readonly #injection: CodingInjection | null;
  #config: PortraitConfig;

  constructor(options: PortraitServiceOptions) {
    this.#drive = options.drive;
    this.#store = options.store;
    this.#paths = options.paths;
    this.#driveRoot = options.driveRoot ?? "";
    this.#config = copyConfig(options.config);
    this.#injection =
      options.consent && options.homeDir && options.managedStatePath
        ? new CodingInjection({
            homeDir: options.homeDir,
            managedStatePath: options.managedStatePath,
            consent: options.consent,
            codingPath: () => this.#codingPath(),
          })
        : null;
  }

  setConfig(config: PortraitConfig): void {
    this.#config = copyConfig(config);
  }

  async pull(): Promise<PortraitPullResult> {
    const variants: PortraitVariantResult[] = [];
    for (const variant of this.#config.variants) {
      variants.push(await this.#pullVariant(variant));
    }
    const injection = this.#injection ? await this.#injection.reconcile() : idleInjection();
    return { variants, injection };
  }

  async getPortrait(variant = "full"): Promise<PortraitDocument> {
    const configured = this.#requireVariant(variant);
    const path = portraitFile(this.#paths, configured.id);
    const local = await readOptional(path);
    if (local !== null) return { variant: configured.id, portrait: local, path };
    const pulled = await this.#pullVariant(configured);
    if (pulled.status === "missing") {
      throw new YouBrainError(
        "SOURCE_UNAVAILABLE",
        `Drive portrait source ${pulled.drivePath} is not available`,
      );
    }
    const text = await readOptional(path);
    if (text === null) {
      throw new YouBrainError(
        "SOURCE_UNAVAILABLE",
        `Local portrait ${path} is not available`,
      );
    }
    return { variant: configured.id, portrait: text, path };
  }

  async listSnapshots(): Promise<PortraitSnapshot[]> {
    const pattern = resolveDrivePath(this.#config.snapshotPattern, this.#driveRoot);
    const prefix = globPrefix(pattern);
    const entries = await this.#drive.list(prefix ? { prefix } : {});
    const matcher = globToRegExp(pattern);
    return entries
      .filter((entry) => matcher.test(entry.path))
      .map((entry) => toSnapshot(entry))
      .sort(
        (left, right) =>
          right.modifiedTime.localeCompare(left.modifiedTime) ||
          left.path.localeCompare(right.path),
      );
  }

  applyConsented(itemIds: readonly string[]): Promise<InjectionSyncResult> {
    if (!this.#injection) {
      throw new YouBrainError("INVALID_INPUT", "Coding injection is not configured");
    }
    return this.#injection.applyConsented(itemIds);
  }

  reconcileCodingInjection(): Promise<InjectionSyncResult> {
    if (!this.#injection) return Promise.resolve(idleInjection());
    return this.#injection.reconcile();
  }

  async #pullVariant(variant: PortraitVariantConfig): Promise<PortraitVariantResult> {
    const drivePath = resolveDrivePath(variant.path, this.#driveRoot);
    const localPath = portraitFile(this.#paths, variant.id);
    const object = await this.#drive.readPath(drivePath);
    if (!object) {
      return { id: variant.id, status: "missing", localPath, drivePath };
    }
    const md5 = object.md5Checksum || md5Hex(object.bytes);
    const etag = object.etag || md5;
    const modifiedTime = isoTime(object.modifiedTime);
    const stored = this.#store.getPortrait(variant.id);
    const meta = stored ? decodePortraitMeta(stored.version) : null;
    const localMd5 = await readMd5(localPath);
    const contentSame = localMd5 === md5;
    const metaSame = Boolean(
      stored &&
        meta &&
        meta.etag === etag &&
        meta.md5 === md5 &&
        meta.drivePath === drivePath &&
        stored.updatedAt === modifiedTime &&
        stored.path === localPath,
    );
    if (!contentSame) await writeFileAtomic(localPath, object.bytes);
    if (!metaSame) {
      this.#store.upsertPortrait({
        variant: variant.id,
        path: localPath,
        version: encodePortraitMeta({ etag, md5, drivePath }),
        updatedAt: modifiedTime,
      });
    }
    const result: PortraitVariantResult = {
      id: variant.id,
      status: contentSame ? "skipped" : "written",
      localPath,
      drivePath,
    };
    result.fileId = object.id;
    return result;
  }

  #requireVariant(id: string): PortraitVariantConfig {
    const found = this.#config.variants.find((variant) => variant.id === id);
    if (!found) throw new YouBrainError("INVALID_INPUT", `Unknown portrait variant ${id}`);
    return found;
  }

  #codingPath(): string {
    return this.#config.variants.find((variant) => variant.id === "coding")?.path ?? "";
  }
}

function copyConfig(config: PortraitConfig): PortraitConfig {
  return {
    variants: config.variants.map((variant) => ({ id: variant.id, path: variant.path })),
    snapshotPattern: config.snapshotPattern,
  };
}

function toSnapshot(entry: DriveEntry): PortraitSnapshot {
  return {
    fileId: entry.id,
    path: entry.path,
    name: basename(entry.path),
    modifiedTime: entry.modifiedTime,
    md5: entry.md5Checksum,
    size: entry.size,
  };
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function readMd5(path: string): Promise<string | null> {
  try {
    return md5Hex(await readFile(path));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}
