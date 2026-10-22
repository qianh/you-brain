import { posix } from "node:path";

import type { Event } from "@you-brain/protocol";

import { ConflictError } from "../drive/errors.js";
import type { DrivePort } from "../drive/drive-port.js";
import { classifyPortraitCorrections } from "../portrait/corrections.js";
import type { PortraitConfig, PortraitService } from "../portrait/service.js";
import { globPrefix, globToRegExp, resolveDrivePath } from "../portrait/path.js";
import type { ConsolidationPortrait } from "./steps.js";

const MARKDOWN = "text/markdown";
const CORRECTION_LIMIT = 20;
const VERSION_IN_NAME = /-v(\d+(?:\.\d+)*)-/u;

export interface DrivePortraitSource {
  drive: DrivePort;
  service: PortraitService;
  driveRoot: string;
  config: () => PortraitConfig;
  events: () => readonly Event[];
}

export function createDrivePortrait(source: DrivePortraitSource): ConsolidationPortrait {
  return {
    async read() {
      const path = fullPath(source);
      if (!path) return null;
      const object = await source.drive.readPath(path);
      if (!object) return null;
      return { text: object.bytes.toString("utf8"), etag: object.etag, fileId: object.id };
    },
    async save(input) {
      const latest = fullPath(source);
      if (!latest) throw new Error("没有配置 full 数字分身路径");
      const snapshotPath = await snapshotPathFor(source, input.day);
      await writeBackup(source.drive, latest, input.previous, input.day);
      try {
        await source.drive.update(input.fileId, input.text, {
          ifMatch: input.etag,
          mimeType: MARKDOWN,
        });
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ConflictError("数字分身在沉淀期间被别处更新");
        }
        throw error;
      }
      await source.drive.create({
        path: snapshotPath,
        bytes: Buffer.from(input.text, "utf8"),
        mimeType: MARKDOWN,
      });
      await source.service.pull();
      return { snapshot: posix.basename(snapshotPath) };
    },
    corrections() {
      return pendingCorrections(source.events());
    },
  };
}

export function pendingCorrections(
  events: readonly Event[],
): Array<{ correctionId: string; section: string; text: string }> {
  return classifyPortraitCorrections(events)
    .filter((item) => item.variant === "full" && item.status === "pending")
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId),
    )
    .slice(0, CORRECTION_LIMIT)
    .map((item) => ({
      correctionId: item.correctionId,
      section: item.section,
      text: item.text,
    }));
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

async function snapshotPathFor(source: DrivePortraitSource, day: string): Promise<string> {
  const pattern = resolveDrivePath(source.config().snapshotPattern, source.driveRoot);
  const version = await nextVersion(source, pattern);
  return fillSnapshotPattern(pattern, version, day);
}

async function nextVersion(source: DrivePortraitSource, pattern: string): Promise<string> {
  const prefix = globPrefix(pattern);
  const entries = await source.drive.list(prefix ? { prefix } : {});
  const matcher = globToRegExp(pattern);
  let best: number[] | null = null;
  for (const entry of entries) {
    if (!matcher.test(entry.path)) continue;
    const version = parseVersion(posix.basename(entry.path));
    if (!version) continue;
    if (best === null || compareVersion(version, best) > 0) best = version;
    else if (compareVersion(version, best) === 0 && version.length > best.length) best = version;
  }
  if (!best) return "1.0.0";
  const next = [...best];
  const last = next.length - 1;
  next[last] = (next[last] ?? 0) + 1;
  return next.join(".");
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

function parseVersion(name: string): number[] | null {
  const match = VERSION_IN_NAME.exec(name);
  const body = match?.[1];
  if (!body) return null;
  return body.split(".").map((part) => Number(part));
}

function compareVersion(left: number[], right: number[]): number {
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function fullPath(source: DrivePortraitSource): string | null {
  const variant = source.config().variants.find((item) => item.id === "full");
  if (!variant) return null;
  return resolveDrivePath(variant.path, source.driveRoot);
}
