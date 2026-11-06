import { posix } from "node:path";

import { DEFAULT_PORTRAIT_VARIANTS, type Event } from "@you-brain/protocol";

import { ConflictError } from "../drive/errors.js";
import type { DriveObject, DrivePort } from "../drive/drive-port.js";
import { classifyPortraitCorrections } from "../portrait/corrections.js";
import type { PortraitConfig, PortraitService } from "../portrait/service.js";
import { resolveDrivePath } from "../portrait/path.js";
import { parseWebSession } from "../web-sessions/parse.js";
import { localDayKey, shiftDateKey } from "./schedule.js";
import type {
  ConsolidationPortrait,
  StoredTwinClaim,
  TwinFileRef,
  TwinProbe,
  TwinSnapshotRef,
} from "./steps.js";
import { TWIN_LAYERS, type TwinLayer } from "./twin.js";

const MARKDOWN = "text/markdown";
const JSONL = "application/x-ndjson";
const CORRECTION_LIMIT = 20;
const CHANGELOG_TITLE = "# 数字分身变更记录";
/** Session files downloaded at the same time; a week of sessions is a few hundred reads. */
const SESSION_READ_CONCURRENCY = 8;

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
    async pendingProbes() {
      return readJsonl(source.drive, paths().pendingProbes, parseProbe);
    },
    async savePendingProbes(probes) {
      await writeJsonl(source.drive, paths().pendingProbes, probes);
    },
    async twinBefore(day) {
      const texts: Partial<Record<"full" | "coding", string>> = {};
      for (const layer of ["full", "coding"] as const) {
        const path = paths().layers[layer];
        const object = (await backupFrom(source.drive, path, day)) ?? (await source.drive.readPath(path));
        if (!object) return null;
        texts[layer] = object.bytes.toString("utf8");
      }
      return { full: texts.full ?? "", coding: texts.coding ?? "" };
    },
    async appendChangelog(entry) {
      await prependChangelog(source.drive, paths().changelog, entry);
    },
    async snapshots() {
      const pattern = resolveDrivePath(source.config().snapshotPattern, source.driveRoot);
      const directory = posix.dirname(pattern);
      const matcher = snapshotMatcher(posix.basename(pattern));
      if (matcher === null) return [];
      const star = posix.basename(pattern).indexOf("*");
      const listPrefix = posix.join(directory, posix.basename(pattern).slice(0, star));
      const out: TwinSnapshotRef[] = [];
      for (const entry of await source.drive.list({ prefix: listPrefix })) {
        if (posix.dirname(entry.path) !== directory) continue;
        const match = matcher.exec(posix.basename(entry.path));
        if (!match) continue;
        out.push({ file: posix.basename(entry.path), version: match[1] ?? "", day: match[2] ?? "" });
      }
      out.sort(
        (left, right) =>
          left.day.localeCompare(right.day) || left.version.localeCompare(right.version),
      );
      return out;
    },
    async readSnapshot(file) {
      if (file.includes("/") || file.includes("..")) return null;
      const pattern = resolveDrivePath(source.config().snapshotPattern, source.driveRoot);
      const directory = posix.dirname(pattern);
      const object = await source.drive.readPath(posix.join(directory, file));
      return object ? object.bytes.toString("utf8") : null;
    },
  };
}

/**
 * A regex from the snapshot pattern: the first `*` captures the version, the second the
 * day — the same order {@link fillSnapshotPattern} writes them.
 */
function snapshotMatcher(basename: string): RegExp | null {
  if ([...basename].filter((char) => char === "*").length !== 2) return null;
  let index = 0;
  const source = [...basename]
    .map((char) => {
      if (char === "*") {
        index += 1;
        return index === 1 ? "([0-9.]+)" : "(\\d{4}-\\d{2}-\\d{2})";
      }
      return char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
}

export interface TwinSessionRow {
  sessionKey: string;
  title: string;
  fileId: string | null;
  updatedAt: string | null;
}

/** The user's own turns for sessions last updated on or after the day before `day`, oldest session first. */
export async function readTwinSessions(input: {
  drive: DrivePort;
  sessions: readonly TwinSessionRow[];
  timeZone: string;
  day: string;
}): Promise<Array<{ sessionKey: string; title: string; turns: string[] }>> {
  // A 03:00 run would miss yesterday's evening without the extra day; the turn cursor skips repeats.
  const since = shiftDateKey(input.day, -1);
  const rows = input.sessions
    .filter(
      (session) =>
        session.fileId !== null &&
        session.updatedAt !== null &&
        localDayKey(new Date(session.updatedAt), input.timeZone) >= since,
    )
    .sort((left, right) => (left.updatedAt ?? "").localeCompare(right.updatedAt ?? ""));
  const sessions: Array<{ sessionKey: string; title: string; turns: string[] }> = [];
  for (let start = 0; start < rows.length; start += SESSION_READ_CONCURRENCY) {
    const batch = rows.slice(start, start + SESSION_READ_CONCURRENCY);
    const objects = await Promise.all(
      batch.map((session) =>
        session.fileId === null ? null : input.drive.read(session.fileId).catch(() => null),
      ),
    );
    batch.forEach((session, index) => {
      const object = objects[index];
      const parsed = object ? parseWebSession(object.bytes.toString("utf8")) : null;
      if (!parsed) return;
      sessions.push({
        sessionKey: session.sessionKey,
        title: session.title,
        turns: parsed.turns.filter((turn) => turn.role === "user").map((turn) => turn.text),
      });
    });
  }
  return sessions;
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
  pendingProbes: string;
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
    pendingProbes: posix.join(base, "eval", "pending-probes.jsonl"),
  };
}

function backupPrefix(latestPath: string): string {
  const directory = posix.dirname(latestPath);
  const base = posix.basename(latestPath, posix.extname(latestPath));
  return posix.join(directory === "." ? "" : directory, "consolidate-backup", `${base}-`);
}

/**
 * The first backup written on or after `day`. A backup holds the text from before that day's
 * first write, so this is the layer as it stood right before the run of `day`.
 */
async function backupFrom(drive: DrivePort, latestPath: string, day: string): Promise<DriveObject | null> {
  const prefix = backupPrefix(latestPath);
  const days = (await drive.list({ prefix }))
    .map((entry) => /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(entry.path.slice(prefix.length))?.[1])
    .filter((value): value is string => value !== undefined && value >= day)
    .sort();
  return days[0] === undefined ? null : drive.readPath(`${prefix}${days[0]}.md`);
}

async function writeBackup(drive: DrivePort, latestPath: string, previous: string, day: string): Promise<void> {
  const backup = `${backupPrefix(latestPath)}${day}.md`;
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
    ...(isDayKey(row.day) ? { day: row.day } : {}),
    ...(isDayKey(row.flat) ? { flat: row.flat } : {}),
  };
}

function isDayKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
}
