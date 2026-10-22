import type { DeviceRecord, Roles, SharedConfig } from "@you-brain/protocol";

import type { EventSink } from "./types.js";
import type {
  PortraitResponse,
  PortraitSnapshot,
  ReminderView,
  RemindersResponse,
  SearchRequest,
  SearchResponse,
  StatusResponse,
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
  search(query: SearchRequest): Promise<SearchResponse>;
  devices(): Promise<DeviceRecord[]>;
  readRoles(): Promise<Roles>;
  writeRoles(roles: Roles): Promise<void>;
  readConfig(): Promise<SharedConfig>;
  writeConfig(config: SharedConfig): Promise<void>;
  status(): Promise<StatusResponse>;
  reminders(all: boolean): Promise<RemindersResponse>;
  reminder(id: string): Promise<ReminderView | null>;
  now(): Date;
  sync(): Promise<SyncActionResult>;
  upload(input: UploadActionInput): Promise<UploadActionResult>;
  events: EventSink;
}
