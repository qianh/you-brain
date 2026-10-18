import { posix } from "node:path";

import {
  YB_SCHEMA_VERSION,
  conversationKey,
  inboxAppProperties,
  inboxSessionPath,
} from "@you-brain/protocol";

import { YouBrainError } from "../domain/errors.js";
import { ConflictError } from "../drive/errors.js";
import type { DriveEntry, DriveObject, DrivePort } from "../drive/drive-port.js";
import { md5Hex, sha256Hex } from "../drive/hash.js";
import { InboxScopedDrive } from "../drive/scoped-drive.js";
import { assertChecksum } from "./checksum.js";
import {
  UploadScheduler,
  systemClock,
  type Clock,
  type ScheduleOptions,
} from "./schedule.js";
import type {
  SessionSource,
  UploadableSession,
  UploadAttempt,
  UploadIndex,
  UploadRecordMeta,
  UploadResult,
} from "./types.js";

interface Revision {
  updatedAt: string;
  messageCount: number;
  bytes: Buffer;
  contentSha256: string;
  appProperties: Record<string, string>;
}

interface Kept {
  entry: DriveEntry;
  revision: Revision;
  action: "updated" | "unchanged";
}

export interface UploadServiceOptions extends ScheduleOptions {
  drive: DrivePort;
  index: UploadIndex;
  deviceId: string;
  clock?: Clock;
  maxAttempts?: number;
  /** Restrict session writes to inbox/. Default true. */
  restrictToInbox?: boolean;
}

function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function compareRevision(left: Revision, right: Revision): number {
  const time = timeValue(left.updatedAt) - timeValue(right.updatedAt);
  if (time !== 0) return time;
  return left.messageCount - right.messageCount;
}

function chooseBest(local: Revision, remotes: readonly Revision[]): Revision {
  let best = local;
  for (const remote of remotes) {
    if (compareRevision(remote, best) > 0) best = remote;
  }
  return best;
}

/** Remote message count is the BrainHub `turn_count` line in the markdown. */
function parseTurnCount(bytes: Buffer): number {
  const match = /^turn_count:\s*(\d+)\s*$/mu.exec(bytes.toString("utf8"));
  const count = match?.[1];
  return count === undefined ? 0 : Number(count);
}

function ensureSchema(properties: Record<string, string>): Record<string, string> {
  if (properties.ybSchema) return properties;
  return { ...properties, ybSchema: YB_SCHEMA_VERSION };
}

function toRevision(file: DriveObject): Revision {
  return {
    updatedAt: file.appProperties.updatedAt ?? "",
    messageCount: parseTurnCount(file.bytes),
    bytes: Buffer.from(file.bytes),
    appProperties: ensureSchema(file.appProperties),
    contentSha256: file.appProperties.contentSha256 ?? sha256Hex(file.bytes),
  };
}

function titleSlug(title: string): string {
  return title
    .trim()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 48);
}

function sessionFileName(session: UploadableSession): string {
  const date = session.startedAt.slice(0, 10).replaceAll("-", "");
  const shortId = session.conversationId.replace(/[^A-Za-z0-9]/gu, "").slice(0, 8);
  const slug = session.title ? titleSlug(session.title) : "";
  const stem = slug
    ? `${session.source}-${date}-${shortId}-${slug}`
    : `${session.source}-${date}-${shortId}`;
  return `${stem}.md`;
}

function earliest(entries: readonly DriveEntry[]): DriveEntry {
  const sorted = [...entries].sort(
    (left, right) =>
      left.createdTime.localeCompare(right.createdTime) ||
      left.id.localeCompare(right.id),
  );
  const first = sorted[0];
  if (!first) {
    throw new YouBrainError("UPLOAD_FAILED", "Canonical session file disappeared");
  }
  return first;
}

export class UploadService {
  readonly #drive: DrivePort;
  readonly #index: UploadIndex;
  readonly #deviceId: string;
  readonly #maxAttempts: number;
  readonly #scheduler: UploadScheduler;

  constructor(options: UploadServiceOptions) {
    this.#drive =
      options.restrictToInbox === false
        ? options.drive
        : new InboxScopedDrive(options.drive);
    this.#index = options.index;
    this.#deviceId = options.deviceId;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    const schedule: ScheduleOptions = {};
    if (options.idleMs !== undefined) schedule.idleMs = options.idleMs;
    if (options.activeIntervalMs !== undefined) {
      schedule.activeIntervalMs = options.activeIntervalMs;
    }
    this.#scheduler = new UploadScheduler(options.clock ?? systemClock, schedule);
  }

  noteActivity(session: UploadableSession, at?: number): void {
    const key = conversationKey(session.source, session.conversationId);
    if (at !== undefined) this.#scheduler.noteActivity(key, at);
    else this.#scheduler.noteActivity(key);
  }

  async upload(session: UploadableSession): Promise<UploadResult> {
    const key = conversationKey(session.source, session.conversationId);
    const bytes = Buffer.from(session.markdown, "utf8");
    const contentSha256 = session.contentSha256 ?? sha256Hex(bytes);
    const local: Revision = {
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      bytes,
      contentSha256,
      appProperties: inboxAppProperties({
        brainhubKey: key,
        source: session.source,
        conversationId: session.conversationId,
        deviceId: this.#deviceId,
        updatedAt: session.updatedAt,
        contentSha256,
      }),
    };
    const desiredPath = inboxSessionPath(session.device, sessionFileName(session));
    const matches = await this.#existing(key);
    if (matches.length === 0) {
      const created = await this.#drive.create({
        path: desiredPath,
        bytes,
        mimeType: "text/markdown",
        appProperties: local.appProperties,
      });
      assertChecksum(created, bytes);
      const after = await this.#existing(key);
      if (after.length <= 1) {
        await this.#remember(key, created, local);
        return {
          key,
          fileId: created.id,
          path: created.path,
          etag: created.etag,
          md5Checksum: created.md5Checksum,
          action: "created",
          renamed: false,
          trashedIds: [],
        };
      }
      return this.#converge(key, after, local, desiredPath, created.id);
    }
    return this.#converge(key, matches, local, desiredPath, null);
  }

  async uploadIfDue(
    session: UploadableSession,
    activityAt?: number,
  ): Promise<UploadAttempt> {
    const key = conversationKey(session.source, session.conversationId);
    if (activityAt !== undefined) this.#scheduler.noteActivity(key, activityAt);
    const decision = this.#scheduler.decide(key);
    if (!decision.due) {
      return {
        status: "waiting",
        key,
        due: false,
        reason: decision.reason,
        waitMs: decision.waitMs,
      };
    }
    const result = await this.upload(session);
    this.#scheduler.noteUpload(key);
    return { status: "uploaded", result };
  }

  async uploadSource(
    source: SessionSource,
    activityAt?: (session: UploadableSession) => number,
  ): Promise<UploadAttempt[]> {
    const sessions = await source.listSessions();
    const results: UploadAttempt[] = [];
    for (const session of sessions) {
      const at = activityAt?.(session);
      results.push(
        at === undefined
          ? await this.uploadIfDue(session)
          : await this.uploadIfDue(session, at),
      );
    }
    return results;
  }

  async #existing(key: string): Promise<DriveEntry[]> {
    const found = await this.#drive.findByAppProperty("brainhubKey", key);
    const indexed = await this.#index.fileIdOf(key);
    if (indexed && !found.some((entry) => entry.id === indexed)) {
      try {
        const object = await this.#drive.read(indexed);
        if (object.appProperties.brainhubKey === key) found.push(object);
      } catch {
        // Stale index entry.
      }
    }
    return found;
  }

  async #readOthers(key: string, canonicalId: string): Promise<DriveObject[]> {
    const matches = await this.#existing(key);
    const objects: DriveObject[] = [];
    for (const match of matches) {
      if (match.id === canonicalId) continue;
      try {
        objects.push(await this.#drive.read(match.id));
      } catch {
        // Duplicate disappeared between list and read.
      }
    }
    return objects;
  }

  async #writeBest(canonicalId: string, key: string, local: Revision): Promise<Kept> {
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      const current = await this.#drive.read(canonicalId);
      const others = await this.#readOthers(key, canonicalId);
      const best = chooseBest(local, [
        toRevision(current),
        ...others.map((file) => toRevision(file)),
      ]);
      if (md5Hex(current.bytes) === md5Hex(best.bytes)) {
        return { entry: current, revision: best, action: "unchanged" };
      }
      try {
        const updated = await this.#drive.update(canonicalId, best.bytes, {
          ifMatch: current.etag,
          mimeType: "text/markdown",
          appProperties: best.appProperties,
        });
        assertChecksum(updated, best.bytes);
        return { entry: updated, revision: best, action: "updated" };
      } catch (error) {
        if (error instanceof ConflictError) continue;
        throw error;
      }
    }
    throw new ConflictError("Drive update exceeded the retry limit");
  }

  async #converge(
    key: string,
    matches: readonly DriveEntry[],
    local: Revision,
    desiredPath: string,
    createdId: string | null,
  ): Promise<UploadResult> {
    // Earliest createdTime keeps a stable fileId across later updates.
    const canonical = earliest(matches);
    const written = await this.#writeBest(canonical.id, key, local);
    const trashedIds: string[] = [];
    const leftovers = (await this.#existing(key)).filter(
      (entry) => entry.id !== canonical.id,
    );
    for (const leftover of leftovers) {
      await this.#drive.trash(leftover.id);
      trashedIds.push(leftover.id);
    }
    trashedIds.sort();
    let entry = written.entry;
    let renamed = false;
    if (entry.path !== desiredPath) {
      const sameDirectory = posix.dirname(entry.path) === posix.dirname(desiredPath);
      const next = sameDirectory
        ? await this.#drive.rename(entry.id, posix.basename(desiredPath))
        : await this.#drive.move(entry.id, desiredPath);
      if (next.id !== entry.id) {
        throw new YouBrainError("UPLOAD_FAILED", "Drive file id changed during rename");
      }
      renamed = posix.basename(next.path) !== posix.basename(entry.path);
      entry = next;
    }
    await this.#remember(key, entry, written.revision);
    const action: UploadResult["action"] =
      written.action === "updated"
        ? "updated"
        : createdId !== null && createdId === entry.id
          ? "created"
          : "unchanged";
    return {
      key,
      fileId: entry.id,
      path: entry.path,
      etag: entry.etag,
      md5Checksum: entry.md5Checksum,
      action,
      renamed,
      trashedIds,
    };
  }

  async #remember(key: string, entry: DriveEntry, revision: Revision): Promise<void> {
    const meta: UploadRecordMeta = {
      path: entry.path,
      etag: entry.etag,
      md5Checksum: entry.md5Checksum,
      contentSha256: revision.contentSha256,
      updatedAt: revision.updatedAt,
      messageCount: revision.messageCount,
    };
    await this.#index.record(key, entry.id, meta);
  }
}
