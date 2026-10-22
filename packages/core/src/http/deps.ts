import type { DeviceRecord, Roles, SharedConfig } from "@you-brain/protocol";

import type { EventSink } from "./types.js";
import type {
  PortraitCorrectionView,
  PortraitResponse,
  PortraitSnapshot,
  ReminderView,
  RemindersResponse,
  SearchRequest,
  SearchResponse,
  StatusResponse,
  ConsolidateActionResult,
  SyncActionResult,
  TodayResponse,
  TodoView,
  TopicDetail,
  TopicsQuery,
  TopicsResponse,
  UploadActionInput,
  UploadActionResult,
} from "./types.js";

/** Read and write ports for the local API. The daemon supplies the implementations. */
export interface HttpDeps {
  today(): Promise<TodayResponse>;
  topics(query: TopicsQuery): Promise<TopicsResponse>;
  topic(id: string): Promise<TopicDetail | null>;
  todo(todoId: string): Promise<TodoView | null>;
  portrait(variant: string): Promise<PortraitResponse | null>;
  portraitSnapshots(): Promise<PortraitSnapshot[]>;
  portraitCorrections(variant?: string): Promise<PortraitCorrectionView[]>;
  search(query: SearchRequest): Promise<SearchResponse>;
  devices(): Promise<DeviceRecord[]>;
  /** Optional so older test doubles keep compiling. The daemon supplies it when Drive is open. */
  registerVirtualDevice?(record: DeviceRecord): Promise<DeviceRecord>;
  removeVirtualDevice?(deviceId: string): Promise<void>;
  readRoles(): Promise<Roles>;
  writeRoles(roles: Roles): Promise<void>;
  readConfig(): Promise<SharedConfig>;
  writeConfig(config: SharedConfig): Promise<void>;
  status(): Promise<StatusResponse>;
  reminders(all: boolean): Promise<RemindersResponse>;
  reminder(id: string): Promise<ReminderView | null>;
  /** Record keyboard, pointer, or other local activity. `at` is already bounded. */
  reportActivity(at: string): Promise<{ at: string }>;
  now(): Date;
  sync(): Promise<SyncActionResult>;
  upload(input: UploadActionInput): Promise<UploadActionResult>;
  /** Optional so older test doubles keep compiling. The daemon always supplies it. */
  consolidate?(input: { force?: boolean }): Promise<ConsolidateActionResult>;
  events: EventSink;
}
