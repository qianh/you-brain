import type {
  DeviceCapability,
  DeviceKind,
  DevicePlatform,
  DeviceRecord,
  Event,
  ProtocolFile,
  Roles,
  SharedConfig,
} from "@you-brain/protocol";

import type { DriveEntry, DrivePort } from "../drive/drive-port.js";
import type { OutboxInput, OutboxRecord, TopicBookPersistence } from "../store/types.js";
import type { TopicBook } from "../topics/types.js";

export interface SyncStore extends TopicBookPersistence {
  enqueueOutbox(input: OutboxInput): void;
  ackOutbox(ids: readonly string[]): number;
  getOutbox(id: string): OutboxRecord | null;
  getCursor(key: string): string | null;
  setCursor(key: string, value: string): void;
  upsertDevice(record: DeviceRecord): DeviceRecord;
  listEvents(): Event[];
}

export interface DeviceIdentity {
  deviceId: string;
  displayName: string;
  kind: DeviceKind;
  platform: DevicePlatform;
  appVersion: string;
  capabilities: readonly DeviceCapability[];
}

export type JsonPatch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: JsonPatch<T[K]> }
    : T;

export interface SyncConfigUpdate {
  shared?: SharedConfig;
  roles?: Roles;
  protocol?: ProtocolFile;
  devices?: DeviceRecord[];
}

export interface SyncListener {
  onTopicsChanged?(book: TopicBook): void | Promise<void>;
  onInboxChanged?(files: readonly DriveEntry[]): void | Promise<void>;
  onDigitalTwinChanged?(files: readonly DriveEntry[]): void | Promise<void>;
  onConfigChanged?(update: SyncConfigUpdate): void | Promise<void>;
}

export interface ProtocolSyncOptions {
  drive: DrivePort;
  store: SyncStore;
  device: DeviceIdentity;
  listener?: SyncListener;
  now?: () => Date;
  ulid?: (timestamp: number) => string;
}

export interface SyncLineError {
  path: string;
  line: number;
  message: string;
}

export interface PullResult {
  initial: boolean;
  applied: number;
  lineErrors: SyncLineError[];
}

export interface FlushedEventFile {
  day: string;
  path: string;
  fileId: string;
  events: number;
}

export interface FlushResult {
  files: FlushedEventFile[];
  eventCount: number;
}
