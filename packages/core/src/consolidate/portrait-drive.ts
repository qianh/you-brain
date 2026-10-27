import { posix } from "node:path";

import { DEFAULT_PORTRAIT_VARIANTS, type Event } from "@you-brain/protocol";

import { ConflictError } from "../drive/errors.js";
import type { DrivePort } from "../drive/drive-port.js";
import { classifyPortraitCorrections } from "../portrait/corrections.js";
import type { PortraitConfig, PortraitService } from "../portrait/service.js";
import { resolveDrivePath } from "../portrait/path.js";
import type { ConsolidationPortrait, StoredTwinClaim, TwinFileRef, TwinProbe } from "./steps.js";
import { TWIN_LAYERS, type TwinLayer } from "./twin.js";

const MARKDOWN = "text/markdown";
const JSONL = "application/x-ndjson";
const CORRECTION_LIMIT = 20;
const CHANGELOG_TITLE = "# 数字分身变更记录";

export interface DrivePortraitSource {
  drive: DrivePort;
  /** Refreshes the local cache after a write. Absent outside the daemon. */
  service?: PortraitService;
  driveRoot: string;
  config: () => PortraitConfig;
  events: () => readonly Event[];
  /** The user's own turns for sessions updated on or after `day`. Absent means none. */
  sessions?: (day: string) => Promise<Array<{ sessionKey: string; title: string; turns: string[] }>>;
}

export function createDrivePortrait(source: DrivePortraitSource): ConsolidationPortrait {
  const paths = () => twinPaths(source);
  return {
    async read() {
      const files = {} as Record<TwinLayer, TwinFileRef | null>;
      for (const layer of TWIN_LAYERS) {
        const object = await source.drive.readPath(paths().layers[layer]);
        files[layer] = object
          ? { text: object.bytes.toString("utf8"), etag: object.etag, fileId: object.id }
          : null;
      }
      return files;
    },
    async sessions(day) {
      return source.sessions ? source.sessions(day) : [];
    },
    corrections() {
      return pendingCorrections(source.events());
    },
    async pendingClaims() {
      return readJsonl(source.drive, paths().pending, parseClaim);
    },
    async saveClaims(input) {
      const where = paths();
      await writeJsonl(source.drive, posix.join(where.claims, `${input.name}.jsonl`), input.claims);
      if (input.pending !== null) await writeJsonl(source.drive, where.pending, input.pending);
    },
    async claimsOf(days) {
      const claims: StoredTwinClaim[] = [];
      for (const day of days) {
        claims.push(...(await readJsonl(source.drive, posix.join(paths().claims, `${day}.jsonl`), parseClaim)));
      }
      return claims;
    },
    async save(input) {
      const where = paths();
      const links: Partial<Record<TwinLayer, string>> = {};
      for (const file of input.files) {
        const path = where.layers[file.layer];
        if (file.previous) {
          await writeBackup(source.drive, path, file.previous.text, input.day);
          try {
            await source.drive.update(file.previous.fileId, file.text, {
              ifMatch: file.previous.etag,
              mimeType: MARKDOWN,
            });
          } catch (error) {
            if (error instanceof ConflictError) {
              throw new ConflictError("数字分身在沉淀期间被别处更新");
            }
            throw error;
          }
          links[file.layer] = driveViewUrl(file.previous.fileId);
        } else {
          const entry = await source.drive.upsert({
            path,
            bytes: Buffer.from(file.text, "utf8"),
            mimeType: MARKDOWN,
          });
          links[file.layer] = driveViewUrl(entry.id);
        }
      }
      let snapshot: string | null = null;
      const full = input.files.find((file) => file.layer === "full");
      if (full) {
        const pattern = resolveDrivePath(source.config().snapshotPattern, source.driveRoot);
        const snapshotPath = fillSnapshotPattern(pattern, input.version, input.day);
        if (!(await source.drive.findByPath(snapshotPath))) {
          await source.drive.create({
            path: snapshotPath,
            bytes: Buffer.from(full.text, "utf8"),
            mimeType: MARKDOWN,
          });
        }
        snapshot = posix.basename(snapshotPath);
      }
      await prependChangelog(source.drive, where.changelog, input.changelog);
      await source.service?.pull();
      return { snapshot, links };
    },
    async probes() {
      return readJsonl(source.drive, paths().probes, parseProbe);
    },
    async saveProbes(probes) {
      await writeJsonl(source.drive, paths().probes, probes);
    },
    async appendChangelog(entry) {
      await prependChangelog(source.drive, paths().changelog, entry);
    },
  };
}

export function pendingCorrections(
  events: readonly Event[],
): Array<{ correctionId: string; variant: string; section: string; text: string }> {
  return classifyPortraitCorrections(events)
    .filter((item) => item.status === "pending")
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId),
    )
    .slice(0, CORRECTION_LIMIT)
    .map((item) => ({
      correctionId: item.correctionId,
      variant: item.variant,
      section: item.section,
      text: item.text,
    }));
}

export function fillSnapshotPattern(pattern: string, version: string, day: string): string {
  const stars = [...pattern].filter((char) => char === "*").length;
  if (stars !== 2) throw new Error(`快照规则必须正好有两个 *，当前是 ${pattern}`);
  let index = 0;
  return pattern.replace(/\*/gu, () => {
    index += 1;
    return index === 1 ? version : day;
  });
}

export function driveViewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

interface TwinPaths {
  layers: Record<TwinLayer, string>;
  claims: string;
  pending: string;
  changelog: string;
  probes: string;
}

/** Layer paths come from config, falling back to the defaults. Side files sit next to `full`. */
function twinPaths(source: DrivePortraitSource): TwinPaths {
  const variants = source.config().variants;
  const layers = {} as Record<TwinLayer, string>;
  for (const layer of TWIN_LAYERS) {
    const configured =
      variants.find((item) => item.id === layer)?.path ??
      DEFAULT_PORTRAIT_VARIANTS.find((item) => item.id === layer)?.path;
    if (!configured) throw new Error(`没有配置 ${layer} 数字分身路径`);
    layers[layer] = resolveDrivePath(configured, source.driveRoot);
  }
  const directory = posix.dirname(layers.full);
  const base = directory === "." ? "" : directory;
  return {
    layers,
    claims: posix.join(base, "claims"),
    pending: posix.join(base, "claims", "pending.jsonl"),
    changelog: posix.join(base, "changelog-latest.md"),
    probes: posix.join(base, "eval", "probes.jsonl"),
  };
}

async function writeBackup(drive: DrivePort, latestPath: string, previous: string, day: string): Promise<void> {
  const directory = posix.dirname(latestPath);
  const base = posix.basename(latestPath, posix.extname(latestPath));
  const backup = posix.join(directory === "." ? "" : directory, "consolidate-backup", `${base}-${day}.md`);
  const existing = await drive.findByPath(backup);
  if (existing) return;
  await drive.create({
    path: backup,
    bytes: Buffer.from(previous, "utf8"),
    mimeType: MARKDOWN,
  });
}

async function prependChangelog(drive: DrivePort, path: string, entry: string): Promise<void> {
  const existing = await drive.readPath(path);
  const old = existing ? existing.bytes.toString("utf8") : "";
  const rest = old.startsWith(CHANGELOG_TITLE) ? old.slice(CHANGELOG_TITLE.length).trim() : old.trim();
  const text = [CHANGELOG_TITLE, entry.trim(), rest].filter((part) => part !== "").join("\n\n");
  await drive.upsert({ path, bytes: Buffer.from(`${text}\n`, "utf8"), mimeType: MARKDOWN });
}

async function readJsonl<T>(drive: DrivePort, path: string, parse: (value: unknown) => T | null): Promise<T[]> {
  const object = await drive.readPath(path);
  if (!object) return [];
  const rows: T[] = [];
  for (const line of object.bytes.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = parse(JSON.parse(line) as unknown);
      if (row !== null) rows.push(row);
    } catch {
      // A broken line is skipped; the rest of the file still counts.
    }
  }
  return rows;
}

async function writeJsonl(drive: DrivePort, path: string, rows: readonly unknown[]): Promise<void> {
  const text = rows.map((row) => JSON.stringify(row)).join("\n");
  await drive.upsert({
    path,
    bytes: Buffer.from(text === "" ? "" : `${text}\n`, "utf8"),
    mimeType: JSONL,
  });
}

function parseClaim(value: unknown): StoredTwinClaim | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const layer = row.layer;
  const confidence = row.confidence;
  if (layer !== "persona" && layer !== "coding" && layer !== "project") return null;
  if (confidence !== "high" && confidence !== "low") return null;
  if (typeof row.text !== "string" || typeof row.day !== "string") return null;
  return {
    layer,
    project: typeof row.project === "string" ? row.project : "",
    confidence,
    text: row.text,
    day: row.day,
  };
}

function parseProbe(value: unknown): TwinProbe | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.situation !== "string" || typeof row.expect !== "string") {
    return null;
  }
  return {
    id: row.id,
    layer: row.layer === "persona" ? "persona" : "coding",
    situation: row.situation,
    expect: row.expect,
  };
}
