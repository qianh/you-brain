import { DRIVE_PATHS, type UiLanguage } from "@you-brain/protocol";

import type { DriveEntry, DrivePort } from "../drive/drive-port.js";
import { sha256Hex } from "../drive/hash.js";
import type { TopicBook, ZonedTopic } from "../topics/types.js";
import { partitionTopics } from "../topics/zones.js";
import { upsertByPath } from "../upload/write.js";
import {
  OVERVIEW_MANIFEST_KEY,
  assignTopicFileStems,
  candidateTopicStems,
  topicIdFromManifestKey,
  topicManifestKey,
  topicZonePath,
} from "./names.js";
import {
  renderTopicDetail,
  renderTopicsOverview,
  type TopicOverviewEntry,
} from "./render.js";

export const TOPIC_FILES_MANIFEST = "topicfiles.manifest";
export const TOPIC_FILES_SWEPT_AT = "topicfiles.swept_at";
const MARKDOWN = "text/markdown";
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface TopicFileEntry {
  fileId: string;
  zone: "active" | "history";
  hash: string;
}

export interface TopicFilesManifestStore {
  get(): string | null;
  set(value: string): void;
}

export interface TopicFilesZone {
  now: string;
  activeLimit: number;
  historyDays: number;
  sessionUpdatedAt?: Readonly<Record<string, string>>;
}

export interface TopicFilesSyncInput {
  drive: DrivePort;
  book: TopicBook;
  language: UiLanguage;
  timeZone: string;
  zone: TopicFilesZone;
  manifest: TopicFilesManifestStore;
  sweptAt?: TopicFilesManifestStore;
}

export interface TopicFilesResult {
  written: number;
  moved: number;
  trashed: number;
  unchanged: number;
  failed: number;
  warnings: string[];
}

export function emptyTopicFilesResult(): TopicFilesResult {
  return { written: 0, moved: 0, trashed: 0, unchanged: 0, failed: 0, warnings: [] };
}

type Manifest = Record<string, TopicFileEntry>;
type TopicDirIndex = Map<string, DriveEntry[]>;

export async function syncTopicFiles(input: TopicFilesSyncInput): Promise<TopicFilesResult> {
  const result = emptyTopicFilesResult();
  const { manifest, intact } = readManifest(input.manifest.get());
  const zoned = partitionTopics(input.book, {
    now: input.zone.now,
    activeLimit: input.zone.activeLimit,
    historyDays: input.zone.historyDays,
    ...(input.zone.sessionUpdatedAt ? { sessionUpdatedAt: input.zone.sessionUpdatedAt } : {}),
  });
  const desired = [...zoned.active, ...zoned.history];
  const desiredIds = new Set(desired.map((topic) => topic.topicId));
  const stems = assignTopicFileStems(input.book.topics.map((topic) => topic.topicId));
  const links = new Map<string, string>();
  for (const topic of desired) {
    const entry = manifest[topicManifestKey(topic.topicId)];
    if (entry) links.set(topic.topicId, entry.fileId);
  }

  let dirIndex: TopicDirIndex | null = null;
  const peekDirIndex = (): TopicDirIndex | null => dirIndex;
  const loadDirIndex = async (): Promise<TopicDirIndex> => {
    if (dirIndex !== null) return dirIndex;
    const entries = await input.drive.list({ prefix: `${DRIVE_PATHS.topics}/` });
    const indexed: TopicDirIndex = new Map();
    for (const entry of entries) {
      const list = indexed.get(entry.path);
      if (list) list.push(entry);
      else indexed.set(entry.path, [entry]);
    }
    for (const list of indexed.values()) {
      list.sort(
        (left, right) =>
          left.createdTime.localeCompare(right.createdTime) || left.id.localeCompare(right.id),
      );
    }
    dirIndex = indexed;
    return indexed;
  };

  for (const topic of desired) {
    try {
      const outcome = await syncTopic(input, manifest, stems, topic, loadDirIndex);
      if (outcome.fileId) links.set(topic.topicId, outcome.fileId);
      if (outcome.unchanged) result.unchanged += 1;
      if (outcome.written) result.written += 1;
      if (outcome.moved) result.moved += 1;
    } catch (error) {
      result.failed += 1;
      result.warnings.push(topicWarning(topic.topicId, error));
    }
  }

  const protectedIds = new Set<string>(links.values());
  for (const topic of desired) {
    const entry = manifest[topicManifestKey(topic.topicId)];
    if (entry) protectedIds.add(entry.fileId);
  }

  const retiredIds = Object.keys(manifest)
    .map((key) => topicIdFromManifestKey(key))
    .filter((topicId): topicId is string => topicId !== null && !desiredIds.has(topicId));
  const trashedIds = new Set<string>();
  for (const topicId of retiredIds) {
    const entry = manifest[topicManifestKey(topicId)];
    if (!entry) continue;
    const removed = await trashFile(
      input.drive,
      topicId,
      entry.fileId,
      protectedIds,
      trashedIds,
      result,
    );
    if (removed) {
      delete manifest[topicManifestKey(topicId)];
      writeManifest(input.manifest, manifest);
    }
  }

  const shouldSweep =
    !intact ||
    (input.sweptAt !== undefined && needsPeriodicSweep(input.sweptAt.get(), input.zone.now));
  if (shouldSweep) {
    const sweptOk = await sweepMergedResiduals(
      input.drive,
      input.book,
      stems,
      protectedIds,
      trashedIds,
      loadDirIndex,
      result,
    );
    if (sweptOk) {
      input.sweptAt?.set(input.zone.now);
    }
  }

  try {
    const overview = renderTopicsOverview({
      active: desired
        .filter((topic) => topic.zone === "active")
        .map((topic) => overviewEntry(topic, links)),
      history: desired
        .filter((topic) => topic.zone === "history")
        .map((topic) => overviewEntry(topic, links)),
      language: input.language,
    });
    const hash = contentHash(overview);
    const previous = manifest[OVERVIEW_MANIFEST_KEY];
    if (previous?.hash === hash) {
      result.unchanged += 1;
    } else {
      const cachedIndex = peekDirIndex();
      const knownOverview =
        cachedIndex !== null ? (cachedIndex.get(DRIVE_PATHS.topicsLatest)?.[0] ?? null) : undefined;
      const saved = await upsertByPath(input.drive, DRIVE_PATHS.topicsLatest, overview, {
        mimeType: MARKDOWN,
        ...(knownOverview !== undefined ? { known: knownOverview } : {}),
      });
      manifest[OVERVIEW_MANIFEST_KEY] = { fileId: saved.id, zone: "active", hash };
      writeManifest(input.manifest, manifest);
      result.written += 1;
    }
  } catch (error) {
    result.failed += 1;
    result.warnings.push(topicWarning("总览", error));
  }
  return result;
}

interface TopicOutcome {
  written: boolean;
  moved: boolean;
  unchanged: boolean;
  fileId: string | null;
}

async function syncTopic(
  input: TopicFilesSyncInput,
  manifest: Manifest,
  stems: ReadonlyMap<string, string>,
  topic: ZonedTopic,
  loadDirIndex: () => Promise<TopicDirIndex>,
): Promise<TopicOutcome> {
  const stem = stems.get(topic.topicId);
  if (!stem) throw new Error("话题文件名缺失");
  const zone = topic.zone;
  const expected = topicZonePath(zone, stem);
  const content = renderTopicDetail({
    topic,
    book: input.book,
    language: input.language,
    timeZone: input.timeZone,
    ...(input.zone.sessionUpdatedAt ? { sessionUpdatedAt: input.zone.sessionUpdatedAt } : {}),
  });
  const hash = contentHash(content);
  const key = topicManifestKey(topic.topicId);
  const entry = manifest[key];
  if (entry && entry.zone === zone && entry.hash === hash) {
    return { written: false, moved: false, unchanged: true, fileId: entry.fileId };
  }

  let fileId = entry?.fileId ?? null;
  let moved = false;
  if (!fileId) {
    const dirIndex = await loadDirIndex();
    const found = findAdoptFromIndex(dirIndex, topic.topicId, stem, expected);
    if (!found) {
      const created = await input.drive.create({
        path: expected,
        bytes: Buffer.from(content, "utf8"),
        mimeType: MARKDOWN,
      });
      manifest[key] = { fileId: created.id, zone, hash };
      writeManifest(input.manifest, manifest);
      return { written: true, moved: false, unchanged: false, fileId: created.id };
    }
    fileId = found.id;
    if (found.path !== expected) {
      await input.drive.move(fileId, expected);
      moved = true;
    }
  } else if (entry && entry.zone !== zone) {
    await input.drive.move(fileId, expected);
    moved = true;
  }

  await input.drive.update(fileId, content, { mimeType: MARKDOWN });
  manifest[key] = { fileId, zone, hash };
  writeManifest(input.manifest, manifest);
  return { written: true, moved, unchanged: false, fileId };
}

function findAdoptFromIndex(
  dirIndex: TopicDirIndex,
  topicId: string,
  stem: string,
  expected: string,
): DriveEntry | null {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  add(expected);
  for (const name of candidateTopicStems(topicId, stem)) {
    add(topicZonePath("active", name));
    add(topicZonePath("history", name));
  }
  for (const path of paths) {
    const found = dirIndex.get(path)?.[0];
    if (found) return found;
  }
  return null;
}

async function sweepMergedResiduals(
  drive: DrivePort,
  book: TopicBook,
  stems: ReadonlyMap<string, string>,
  protectedIds: ReadonlySet<string>,
  trashedIds: Set<string>,
  loadDirIndex: () => Promise<TopicDirIndex>,
  result: TopicFilesResult,
): Promise<boolean> {
  let dirIndex: TopicDirIndex;
  try {
    dirIndex = await loadDirIndex();
  } catch (error) {
    result.warnings.push(failureNote("残留清理", "列目录失败", error));
    return false;
  }
  let allRemoved = true;
  for (const topic of book.topics) {
    if (topic.mergedInto === null) continue;
    const stem = stems.get(topic.topicId);
    const names = stem ? candidateTopicStems(topic.topicId, stem) : [];
    for (const name of names) {
      for (const zone of ["active", "history"] as const) {
        const matches = dirIndex.get(topicZonePath(zone, name));
        if (!matches) continue;
        for (const found of matches) {
          if (protectedIds.has(found.id)) continue;
          const removed = await trashFile(
            drive,
            topic.topicId,
            found.id,
            protectedIds,
            trashedIds,
            result,
          );
          if (!removed) allRemoved = false;
        }
      }
    }
  }
  return allRemoved;
}

function needsPeriodicSweep(raw: string | null, nowIso: string): boolean {
  if (raw === null || raw.trim() === "") return true;
  const sweptMs = Date.parse(raw);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(sweptMs) || Number.isNaN(nowMs)) return true;
  return nowMs - sweptMs >= SWEEP_INTERVAL_MS;
}

async function trashFile(
  drive: DrivePort,
  topicId: string,
  fileId: string,
  protectedIds: ReadonlySet<string>,
  trashedIds: Set<string>,
  result: TopicFilesResult,
): Promise<boolean> {
  if (protectedIds.has(fileId) || trashedIds.has(fileId)) return true;
  try {
    await drive.trash(fileId);
    trashedIds.add(fileId);
    result.trashed += 1;
    return true;
  } catch (error) {
    result.warnings.push(deleteWarning(topicId, error));
    try {
      await drive.read(fileId);
      return false;
    } catch {
      trashedIds.add(fileId);
      return true;
    }
  }
}

function overviewEntry(topic: ZonedTopic, links: ReadonlyMap<string, string>): TopicOverviewEntry {
  return { topic, fileId: links.get(topic.topicId) ?? null };
}

function contentHash(text: string): string {
  return sha256Hex(Buffer.from(text, "utf8"));
}

function topicWarning(topicId: string, error: unknown): string {
  return failureNote(topicId, "文件没有写上", error);
}

function deleteWarning(topicId: string, error: unknown): string {
  return failureNote(topicId, "文件没有删掉", error);
}

function failureNote(topicId: string, action: string, error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  const detail = message === "" ? "失败" : message;
  const text = `话题 ${topicId} ${action}：${detail}`;
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

function readManifest(raw: string | null): { manifest: Manifest; intact: boolean } {
  if (raw === null || raw.trim() === "") return { manifest: {}, intact: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { manifest: {}, intact: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { manifest: {}, intact: false };
  }
  const manifest: Manifest = {};
  let intact = true;
  for (const [key, value] of Object.entries(parsed)) {
    if (!isEntry(value)) {
      intact = false;
      continue;
    }
    manifest[key] = {
      fileId: value.fileId,
      zone: value.zone,
      hash: value.hash,
    };
  }
  return { manifest, intact };
}

function isEntry(value: unknown): value is TopicFileEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as { fileId?: unknown; zone?: unknown; hash?: unknown };
  return (
    typeof entry.fileId === "string" &&
    entry.fileId.length > 0 &&
    (entry.zone === "active" || entry.zone === "history") &&
    typeof entry.hash === "string" &&
    entry.hash.length > 0
  );
}

function writeManifest(store: TopicFilesManifestStore, manifest: Manifest): void {
  const ordered: Manifest = {};
  for (const key of Object.keys(manifest).sort()) {
    const entry = manifest[key];
    if (entry) ordered[key] = entry;
  }
  store.set(JSON.stringify(ordered));
}
