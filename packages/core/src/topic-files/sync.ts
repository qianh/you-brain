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
const MARKDOWN = "text/markdown";

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

export async function syncTopicFiles(input: TopicFilesSyncInput): Promise<TopicFilesResult> {
  const result = emptyTopicFilesResult();
  const manifest = readManifest(input.manifest.get());
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

  for (const topic of desired) {
    try {
      const outcome = await syncTopic(input, manifest, stems, topic);
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
  const retiredIds = new Set(
    Object.keys(manifest)
      .map((key) => topicIdFromManifestKey(key))
      .filter((topicId): topicId is string => topicId !== null && !desiredIds.has(topicId)),
  );
  for (const topic of input.book.topics) {
    if (topic.mergedInto !== null) retiredIds.add(topic.topicId);
  }
  const retired = [...retiredIds];
  const trashedIds = new Set<string>();
  for (const topicId of retired) {
    const removed = await retireTopic(
      input.drive,
      manifest,
      stems,
      topicId,
      protectedIds,
      trashedIds,
      result,
    );
    if (removed) {
      delete manifest[topicManifestKey(topicId)];
      writeManifest(input.manifest, manifest);
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
      const saved = await upsertByPath(input.drive, DRIVE_PATHS.topicsLatest, overview, {
        mimeType: MARKDOWN,
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
    const found = await findAdopt(input.drive, topic.topicId, stem, expected);
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

async function findAdopt(
  drive: DrivePort,
  topicId: string,
  stem: string,
  expected: string,
): Promise<DriveEntry | null> {
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
    const found = await drive.findByPath(path);
    if (found) return found;
  }
  return null;
}

async function retireTopic(
  drive: DrivePort,
  manifest: Manifest,
  stems: ReadonlyMap<string, string>,
  topicId: string,
  protectedIds: ReadonlySet<string>,
  trashedIds: Set<string>,
  result: TopicFilesResult,
): Promise<boolean> {
  const entry = manifest[topicManifestKey(topicId)];
  let gone = true;
  if (entry) {
    gone = await trashFile(drive, topicId, entry.fileId, protectedIds, trashedIds, result);
  }
  const stem = stems.get(topicId);
  const names = stem ? candidateTopicStems(topicId, stem) : [];
  for (const name of names) {
    for (const zone of ["active", "history"] as const) {
      let found: DriveEntry | null = null;
      try {
        found = await drive.findByPath(topicZonePath(zone, name));
      } catch (error) {
        result.warnings.push(deleteWarning(topicId, error));
        gone = false;
        continue;
      }
      if (!found || protectedIds.has(found.id)) continue;
      const removed = await trashFile(drive, topicId, found.id, protectedIds, trashedIds, result);
      if (!removed) gone = false;
    }
  }
  return gone;
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

function readManifest(raw: string | null): Manifest {
  if (raw === null || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const manifest: Manifest = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isEntry(value)) continue;
    manifest[key] = {
      fileId: value.fileId,
      zone: value.zone,
      hash: value.hash,
    };
  }
  return manifest;
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
