import {
  DRIVE_PATHS,
  DEFAULT_EVENT_FLUSH_SECONDS,
  DEFAULT_HEARTBEAT_MINUTES,
  PROTOCOL_VERSION,
  createDefaultRoles,
  createDefaultSharedConfig,
  deviceRecordPath,
  eventLogPath,
  mergeDefaults,
  parseDeviceRecord,
  parseEventsJsonl,
  parseProtocolFile,
  parseRoles,
  parseSharedConfig,
  serializeEventsJsonl,
  type DeviceRecord,
  type Event,
  type EventOf,
  type EventType,
  type ProtocolFile,
  type Roles,
  type SharedConfig,
} from "@you-brain/protocol";

import { YouBrainError } from "../domain/errors.js";
import type { DriveChanges, DriveEntry, DrivePort } from "../drive/drive-port.js";
import { ACTIVITY_EPOCH } from "../reminders/delivery.js";
import { updateJsonWithMerge, upsertByPath } from "../upload/write.js";
import { applyEvents, foldEvents, persistTopicBook } from "../topics/index.js";
import type { TopicBook } from "../topics/types.js";
import { zonedDay } from "./day.js";
import { lineCursorKey, SYNC_DRIVE_CURSOR } from "./cursors.js";
import { EventLog, type AllocateOptions } from "./event-log.js";
import { selectNewLines } from "./lines.js";
import { readOutboxQueue, writeOutboxQueue } from "./queue.js";
import type {
  DeviceIdentity,
  FlushResult,
  FlushedEventFile,
  DeviceActivityOptions,
  JsonPatch,
  ProtocolSyncOptions,
  PullResult,
  SyncConfigUpdate,
  SyncLineError,
  SyncListener,
  SyncStore,
} from "./types.js";

export const EVENT_FLUSH_INTERVAL_MS = DEFAULT_EVENT_FLUSH_SECONDS * 1000;
export const HEARTBEAT_INTERVAL_MS = DEFAULT_HEARTBEAT_MINUTES * 60 * 1000;

const JSONL_MIME = "application/jsonl";
const JSON_MIME = "application/json";

const YOU_BRAIN_PREFIX = `${DRIVE_PATHS.youBrain}/`;
const INBOX_PREFIX = `${DRIVE_PATHS.inbox}/`;
const TWIN_PREFIX = `${DRIVE_PATHS.digitalTwin}/`;
const DEVICES_PREFIX = `${DRIVE_PATHS.devicesDir}/`;
const CHANGE_PREFIXES = [YOU_BRAIN_PREFIX, INBOX_PREFIX, TWIN_PREFIX] as const;

interface ClassifiedChanges {
  events: DriveEntry[];
  inbox: DriveEntry[];
  twins: DriveEntry[];
  shared: boolean;
  roles: boolean;
  protocol: DriveEntry | null;
  devices: DriveEntry[];
}

interface EventRead {
  events: Event[];
  cursors: { fileId: string; next: number }[];
  errors: SyncLineError[];
}

interface DayWrite {
  entry: DriveEntry;
  included: Event[];
  eventCount: number;
}

function deviceIdFromPath(path: string): string | null {
  if (!path.startsWith(DEVICES_PREFIX) || !path.endsWith(".json")) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const deviceId = name.slice(0, -".json".length);
  return deviceId.length > 0 ? deviceId : null;
}

function dedupeEntries(entries: readonly DriveEntry[]): DriveEntry[] {
  const byId = new Map<string, DriveEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

function classify(entries: readonly DriveEntry[]): ClassifiedChanges {
  const result: ClassifiedChanges = {
    events: [],
    inbox: [],
    twins: [],
    shared: false,
    roles: false,
    protocol: null,
    devices: [],
  };
  for (const entry of entries) {
    const path = entry.path;
    if (path.startsWith(`${DRIVE_PATHS.eventsDir}/`) && path.endsWith(".jsonl")) {
      result.events.push(entry);
    } else if (path.startsWith(`${DRIVE_PATHS.inbox}/`)) {
      result.inbox.push(entry);
    } else if (path.startsWith(`${DRIVE_PATHS.digitalTwin}/`)) {
      result.twins.push(entry);
    } else if (path === DRIVE_PATHS.sharedConfig) {
      result.shared = true;
    } else if (path === DRIVE_PATHS.roles) {
      result.roles = true;
    } else if (path === DRIVE_PATHS.protocolFile) {
      result.protocol = entry;
    } else if (path.startsWith(`${DRIVE_PATHS.devicesDir}/`) && path.endsWith(".json")) {
      result.devices.push(entry);
    }
  }
  return result;
}

function parseJsonText(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new YouBrainError("CONFIG_INVALID", `Drive JSON file is not valid JSON: ${path}`);
  }
}

async function readJson(drive: DrivePort, path: string): Promise<unknown | null> {
  const object = await drive.readPath(path);
  if (!object) return null;
  const text = object.bytes.toString("utf8");
  if (text.trim() === "") return null;
  return parseJsonText(text, path);
}

function activityMs(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Newer instant wins. Missing on both sides is the epoch, not "now". */
function mergeLastActiveAt(existing: string | null, incoming: string | null): string {
  const incomingMs = activityMs(incoming);
  const existingMs = activityMs(existing);
  if (incomingMs === null && existingMs === null) return ACTIVITY_EPOCH;
  if (incomingMs === null) return existing ?? ACTIVITY_EPOCH;
  if (existingMs === null || incomingMs > existingMs) return new Date(incomingMs).toISOString();
  return existing ?? ACTIVITY_EPOCH;
}

function unionBySeq(groups: readonly (readonly Event[])[]): Event[] {
  const byId = new Map<string, Event>();
  for (const group of groups) {
    for (const event of group) byId.set(event.id, event);
  }
  return [...byId.values()].sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}

export class ProtocolSync {
  readonly #drive: DrivePort;
  readonly #store: SyncStore;
  readonly #device: DeviceIdentity;
  readonly #listener: SyncListener | undefined;
  readonly #now: () => Date;
  readonly #log: EventLog;
  #flushChain: Promise<void> = Promise.resolve();

  constructor(options: ProtocolSyncOptions) {
    this.#drive = options.drive;
    this.#store = options.store;
    this.#device = options.device;
    this.#listener = options.listener;
    this.#now = options.now ?? (() => new Date());
    this.#log = new EventLog(options.store, options.device.deviceId, {
      now: this.#now,
      ...(options.ulid ? { ulid: options.ulid } : {}),
    });
  }

  topicBook(): TopicBook {
    return foldEvents(this.#store.listEvents());
  }

  pendingEvents(): Event[] {
    return this.#pending();
  }

  async append<T extends EventType>(
    type: T,
    data: EventOf<T>["data"],
    options: AllocateOptions = {},
  ): Promise<EventOf<T>> {
    const event = this.#log.allocate(type, data, options);
    const queue = readOutboxQueue(this.#store, this.#device.deviceId);
    queue.push(event);
    writeOutboxQueue(this.#store, this.#device.deviceId, queue);
    this.#store.enqueueOutbox({
      id: event.id,
      kind: "event",
      payload: event,
      createdAt: event.ts,
    });
    const applied = this.#apply([event]);
    if (applied.applied > 0) await this.#emitTopics(applied.book);
    return event;
  }

  /**
   * Serialize this device's pending events into per-day jsonl files.
   * Callers schedule this every {@link EVENT_FLUSH_INTERVAL_MS}.
   * A failed day leaves that day's outbox intact for the next call.
   */
  flush(): Promise<FlushResult> {
    const run = this.#flushChain.then(() => this.#flushBody());
    this.#flushChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async pull(): Promise<PullResult> {
    await this.#healLocal();
    const cursor = this.#store.getCursor(SYNC_DRIVE_CURSOR);
    if (!cursor) return this.#pullInitial();
    return this.#pullIncremental(cursor);
  }

  async register(options?: DeviceActivityOptions): Promise<DeviceRecord> {
    await this.ensureProtocol();
    return this.#writeDevice(options?.lastActiveAt);
  }

  async heartbeat(options?: DeviceActivityOptions): Promise<DeviceRecord> {
    return this.#writeDevice(options?.lastActiveAt);
  }

  /**
   * Write another device's record. Only `kind: "virtual"` is accepted.
   * `lastActiveAt` does not move backward. `lastSeenAt` is the incoming value.
   */
  async registerVirtual(record: DeviceRecord): Promise<DeviceRecord> {
    const incoming = parseDeviceRecord(record);
    if (incoming.kind !== "virtual") {
      throw new YouBrainError("INVALID_INPUT", "只能注册虚拟设备");
    }
    const path = deviceRecordPath(incoming.deviceId);
    const result = await updateJsonWithMerge<DeviceRecord>(this.#drive, path, (current) => {
      const existing = current === null ? null : parseDeviceRecord(current);
      if (existing && existing.kind !== "virtual") {
        throw new YouBrainError("INVALID_INPUT", "已有同名非虚拟设备记录");
      }
      return parseDeviceRecord({
        ...incoming,
        lastActiveAt: mergeLastActiveAt(existing?.lastActiveAt ?? null, incoming.lastActiveAt),
      });
    });
    return this.#store.upsertDevice(result.value);
  }

  /** Trash a virtual device file and drop the local row. Peers drop it on the next pull. */
  async removeDevice(deviceId: string): Promise<void> {
    const path = deviceRecordPath(deviceId);
    const remote = await this.#drive.findByPath(path);
    const local = this.#store.getDevice(deviceId);
    let kind = local?.kind ?? null;
    if (remote) {
      const object = await this.#drive.read(remote.id);
      kind = parseDeviceRecord(parseJsonText(object.bytes.toString("utf8"), path)).kind;
    }
    if (!remote && !local) {
      throw new YouBrainError("INVALID_INPUT", "设备不存在");
    }
    if (kind !== "virtual") {
      throw new YouBrainError("INVALID_INPUT", "只能移除虚拟设备");
    }
    if (remote) await this.#drive.trash(remote.id);
    this.#store.deleteDevice(deviceId);
  }

  async readShared(): Promise<SharedConfig> {
    const current = await readJson(this.#drive, DRIVE_PATHS.sharedConfig);
    if (current === null) return createDefaultSharedConfig();
    return parseSharedConfig(current);
  }

  async readRoles(): Promise<Roles> {
    const current = await readJson(this.#drive, DRIVE_PATHS.roles);
    if (current === null) return createDefaultRoles();
    return parseRoles(current);
  }

  async updateShared(patch: JsonPatch<SharedConfig>): Promise<SharedConfig> {
    const result = await updateJsonWithMerge<SharedConfig>(
      this.#drive,
      DRIVE_PATHS.sharedConfig,
      (current) => {
        const base = current === null ? createDefaultSharedConfig() : parseSharedConfig(current);
        return parseSharedConfig(mergeDefaults(base, patch));
      },
    );
    await this.#emitConfig({ shared: result.value });
    return result.value;
  }

  async updateRoles(patch: JsonPatch<Roles>): Promise<Roles> {
    const result = await updateJsonWithMerge<Roles>(this.#drive, DRIVE_PATHS.roles, (current) => {
      const base = current === null ? createDefaultRoles() : parseRoles(current);
      return parseRoles(mergeDefaults(base, patch));
    });
    await this.#emitConfig({ roles: result.value });
    return result.value;
  }

  async ensureProtocol(): Promise<ProtocolFile> {
    const current = await readJson(this.#drive, DRIVE_PATHS.protocolFile);
    if (current !== null) return parseProtocolFile(current);
    const value = { version: PROTOCOL_VERSION } satisfies ProtocolFile;
    await upsertByPath(
      this.#drive,
      DRIVE_PATHS.protocolFile,
      `${JSON.stringify(value, null, 2)}\n`,
      { mimeType: JSON_MIME },
    );
    return value;
  }

  async #flushBody(): Promise<FlushResult> {
    const roles = await this.readRoles();
    const pending = this.#pending();
    if (pending.length === 0) return { files: [], eventCount: 0 };
    const healed = this.#apply(pending);
    if (healed.applied > 0) await this.#emitTopics(healed.book);
    const days = [
      ...new Set(pending.map((event) => this.#dayOf(event, roles.timezone))),
    ].sort();
    const files: FlushedEventFile[] = [];
    let eventCount = 0;
    for (const day of days) {
      const written = await this.#writeDay(day, roles.timezone);
      this.#ack(written.included);
      eventCount += written.included.length;
      files.push({
        day,
        path: eventLogPath(this.#device.deviceId, day),
        fileId: written.entry.id,
        events: written.eventCount,
      });
    }
    return { files, eventCount };
  }

  async #writeDay(day: string, timeZone: string): Promise<DayWrite> {
    const path = eventLogPath(this.#device.deviceId, day);
    const remote = await this.#drive.readPath(path);
    const remoteEvents = remote
      ? parseEventsJsonl(remote.bytes.toString("utf8")).events.filter(
          (event) => event.device === this.#device.deviceId,
        )
      : [];
    const included = this.#pending().filter(
      (event) => this.#dayOf(event, timeZone) === day,
    );
    const local = this.#store
      .listEvents()
      .filter(
        (event) =>
          event.device === this.#device.deviceId && this.#dayOf(event, timeZone) === day,
      );
    const merged = unionBySeq([remoteEvents, local, included]);
    const body = serializeEventsJsonl(merged);
    const entry = await upsertByPath(this.#drive, path, body, { mimeType: JSONL_MIME });
    return { entry, included, eventCount: merged.length };
  }

  async #pullInitial(): Promise<PullResult> {
    await this.ensureProtocol();
    const entries = dedupeEntries([
      ...(await this.#drive.list({ prefix: YOU_BRAIN_PREFIX })),
      ...(await this.#drive.list({ prefix: INBOX_PREFIX })),
      ...(await this.#drive.list({ prefix: TWIN_PREFIX })),
    ]);
    const body = await this.#consume(entries, true);
    await this.#emitRemovedDevices(await this.#reconcileDevices());
    const token = await this.#drive.startPageToken();
    this.#store.setCursor(SYNC_DRIVE_CURSOR, token);
    return { initial: true, ...body };
  }

  async #pullIncremental(cursor: string): Promise<PullResult> {
    const pages: DriveChanges[] = [];
    for (const prefix of CHANGE_PREFIXES) {
      pages.push(await this.#drive.changes({ prefix, cursor }));
    }
    const primary = pages[0];
    if (!primary) {
      throw new YouBrainError("INVALID_INPUT", "Drive change feed returned no page");
    }
    const entries = dedupeEntries(pages.flatMap((page) => page.entries));
    const body = await this.#consume(entries, false);
    if (pages.some((page) => page.removedIds.length > 0)) {
      await this.#emitRemovedDevices(await this.#reconcileDevices());
    }
    this.#store.setCursor(SYNC_DRIVE_CURSOR, primary.cursor);
    return { initial: false, ...body };
  }

  /**
   * `removedIds` are file ids without paths. List device files and drop virtual
   * rows that are gone. Physical rows stay, so a bad list cannot erase them.
   * Runs before the sync cursor advances; a list error fails the pull.
   */
  async #reconcileDevices(): Promise<string[]> {
    const remote = new Set<string>();
    for (const entry of await this.#drive.list({ prefix: DEVICES_PREFIX })) {
      const deviceId = deviceIdFromPath(entry.path);
      if (deviceId) remote.add(deviceId);
    }
    const removed: string[] = [];
    for (const device of this.#store.listDevices()) {
      if (device.kind !== "virtual") continue;
      if (device.deviceId === this.#device.deviceId) continue;
      if (remote.has(device.deviceId)) continue;
      removed.push(device.deviceId);
    }
    removed.sort();
    for (const deviceId of removed) this.#store.deleteDevice(deviceId);
    return removed;
  }

  async #emitRemovedDevices(deviceIds: readonly string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    const update: SyncConfigUpdate = { removedDevices: [...deviceIds] };
    if (this.#configHasFields(update)) await this.#emitConfig(update);
  }

  async #consume(
    entries: readonly DriveEntry[],
    initial: boolean,
  ): Promise<Pick<PullResult, "applied" | "lineErrors">> {
    const buckets = classify(entries);
    const eventRead = await this.#readEventFiles(buckets.events, initial);
    const update = await this.#readConfig(buckets, initial);
    for (const device of update.devices ?? []) this.#store.upsertDevice(device);
    const applied = this.#apply(eventRead.events);
    if (applied.applied > 0) await this.#emitTopics(applied.book);
    if (buckets.inbox.length > 0) await this.#listener?.onInboxChanged?.(buckets.inbox);
    if (buckets.twins.length > 0) await this.#listener?.onDigitalTwinChanged?.(buckets.twins);
    if (this.#configHasFields(update)) await this.#emitConfig(update);
    for (const cursor of eventRead.cursors) {
      this.#store.setCursor(lineCursorKey(cursor.fileId), String(cursor.next));
    }
    return { applied: applied.applied, lineErrors: eventRead.errors };
  }

  async #readEventFiles(files: readonly DriveEntry[], initial: boolean): Promise<EventRead> {
    const events: Event[] = [];
    const cursors: { fileId: string; next: number }[] = [];
    const errors: SyncLineError[] = [];
    for (const file of files) {
      const object = await this.#drive.read(file.id);
      const text = object.bytes.toString("utf8");
      const readLines = initial ? 0 : this.#lineCursor(file.id);
      const selected = selectNewLines(text, readLines);
      const body = selected.lines.length === 0 ? "" : `${selected.lines.join("\n")}\n`;
      const parsed = parseEventsJsonl(body);
      const offset = selected.reset ? 0 : readLines;
      for (const error of parsed.errors) {
        errors.push({
          path: file.path,
          line: error.line + offset,
          message: error.message,
        });
      }
      events.push(...parsed.events);
      cursors.push({ fileId: file.id, next: selected.next });
    }
    return { events, cursors, errors };
  }

  async #readConfig(buckets: ClassifiedChanges, initial: boolean): Promise<SyncConfigUpdate> {
    const update: SyncConfigUpdate = {};
    if (initial || buckets.shared) update.shared = await this.readShared();
    if (initial || buckets.roles) update.roles = await this.readRoles();
    if (buckets.protocol) {
      const object = await this.#drive.read(buckets.protocol.id);
      update.protocol = parseProtocolFile(
        parseJsonText(object.bytes.toString("utf8"), buckets.protocol.path),
      );
    } else if (initial) {
      const current = await readJson(this.#drive, DRIVE_PATHS.protocolFile);
      if (current !== null) update.protocol = parseProtocolFile(current);
    }
    if (buckets.devices.length > 0) {
      const devices: DeviceRecord[] = [];
      for (const file of buckets.devices) {
        const object = await this.#drive.read(file.id);
        devices.push(
          parseDeviceRecord(parseJsonText(object.bytes.toString("utf8"), file.path)),
        );
      }
      update.devices = devices;
    }
    return update;
  }

  async #writeDevice(incoming: string | null | undefined): Promise<DeviceRecord> {
    const now = this.#now().toISOString();
    const path = deviceRecordPath(this.#device.deviceId);
    const result = await updateJsonWithMerge<DeviceRecord>(this.#drive, path, (current) => {
      const existing = current === null ? null : parseDeviceRecord(current);
      const lastActiveAt = mergeLastActiveAt(existing?.lastActiveAt ?? null, incoming ?? null);
      return parseDeviceRecord({
        deviceId: this.#device.deviceId,
        displayName: this.#device.displayName,
        kind: this.#device.kind,
        platform: this.#device.platform,
        appVersion: this.#device.appVersion,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...this.#device.capabilities],
        lastSeenAt: now,
        lastActiveAt,
      });
    });
    return this.#store.upsertDevice(result.value);
  }

  async #healLocal(): Promise<void> {
    const pending = this.#pending();
    if (pending.length === 0) return;
    const applied = this.#apply(pending);
    if (applied.applied > 0) await this.#emitTopics(applied.book);
  }

  #pending(): Event[] {
    const queued = readOutboxQueue(this.#store, this.#device.deviceId);
    const pending = queued.filter((event) => {
      const row = this.#store.getOutbox(event.id);
      return !row || row.status !== "acked";
    });
    if (pending.length !== queued.length) {
      writeOutboxQueue(this.#store, this.#device.deviceId, pending);
    }
    return pending;
  }

  #ack(events: readonly Event[]): void {
    if (events.length === 0) return;
    const ids = new Set(events.map((event) => event.id));
    this.#store.ackOutbox([...ids]);
    const remaining = readOutboxQueue(this.#store, this.#device.deviceId).filter(
      (event) => !ids.has(event.id),
    );
    writeOutboxQueue(this.#store, this.#device.deviceId, remaining);
  }

  #apply(events: readonly Event[]): { book: TopicBook; applied: number } {
    if (events.length === 0) {
      return { book: this.topicBook(), applied: 0 };
    }
    const current = this.topicBook();
    const before = current.memory.ids.size;
    const next = applyEvents(current, events);
    const applied = next.memory.ids.size - before;
    if (applied > 0) persistTopicBook(this.#store, next);
    return { book: next, applied };
  }

  #lineCursor(fileId: string): number {
    const raw = this.#store.getCursor(lineCursorKey(fileId));
    if (raw === null) return 0;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) return -1;
    return value;
  }

  #dayOf(event: Event, timeZone: string): string {
    const instant = new Date(event.ts);
    if (Number.isNaN(instant.getTime())) {
      throw new YouBrainError("INVALID_INPUT", `Event ${event.id} has an invalid timestamp`);
    }
    return zonedDay(instant, timeZone);
  }

  #configHasFields(update: SyncConfigUpdate): boolean {
    return (
      update.shared !== undefined ||
      update.roles !== undefined ||
      update.protocol !== undefined ||
      update.devices !== undefined ||
      (update.removedDevices?.length ?? 0) > 0
    );
  }

  async #emitTopics(book: TopicBook): Promise<void> {
    await this.#listener?.onTopicsChanged?.(book);
  }

  async #emitConfig(update: SyncConfigUpdate): Promise<void> {
    await this.#listener?.onConfigChanged?.(update);
  }
}
