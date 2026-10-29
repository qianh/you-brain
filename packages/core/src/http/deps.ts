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
  WebhookPublic,
  WebhookPutBody,
  WebhookTestResult,
  LlmKeyPutBody,
  LlmTestBody,
  LlmTestResult,
  GoogleLoginResult,
  GoogleLogoutResult,
  NotionArchivePageBody,
  NotionArchivePageResult,
  NotionAsset,
  NotionCreatePageBody,
  NotionCreatePageResult,
  NotionDatabaseView,
  NotionDeleteBlockBody,
  NotionDuplicateBlockBody,
  NotionKeyPutBody,
  NotionMoveBlockBody,
  NotionPageMutationResult,
  NotionPageView,
  NotionAppendBlockBody,
  NotionPatchTitleBody,
  NotionSearchView,
  NotionStatusView,
  NotionSyncResult,
  NotionTestResult,
  NotionTreeView,
  NotionUpdateBlockBody,
  OAuthClientPublic,
  OAuthClientPutBody,
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
  /** Optional so older test doubles keep compiling. The daemon always supplies it. */
  readWebhook?(): Promise<WebhookPublic>;
  writeWebhook?(body: WebhookPutBody): Promise<WebhookPublic>;
  testWebhook?(): Promise<WebhookTestResult>;
  /** Optional so older test doubles keep compiling. The daemon always supplies it. */
  writeLlmKey?(body: LlmKeyPutBody): Promise<void>;
  /** Optional so older test doubles keep compiling. The daemon always supplies it. */
  testLlm?(body: LlmTestBody): Promise<LlmTestResult>;
  /** Optional so older test doubles keep compiling. The daemon always supplies it. */
  googleLogin?(): Promise<GoogleLoginResult>;
  /** Optional so older test doubles keep compiling. The daemon always supplies both. */
  googleLogout?(): Promise<GoogleLogoutResult>;
  googleSwitch?(): Promise<GoogleLogoutResult>;
  /** 自带 OAuth 凭据（每人自己的 Google Cloud 项目）。 */
  readOAuthClient?(): Promise<OAuthClientPublic>;
  writeOAuthClient?(body: OAuthClientPutBody): Promise<OAuthClientPublic>;
  /** 知识库（Notion，只读）。The daemon always supplies these. */
  notionStatus?(): Promise<NotionStatusView>;
  notionTest?(): Promise<NotionTestResult>;
  writeNotionKey?(body: NotionKeyPutBody): Promise<void>;
  notionSync?(): Promise<NotionSyncResult>;
  notionTree?(): Promise<NotionTreeView>;
  notionPage?(pageId: string): Promise<NotionPageView | null>;
  notionSearch?(query: string, limit?: number): Promise<NotionSearchView>;
  notionDatabase?(databaseId: string): Promise<NotionDatabaseView | null>;
  notionAsset?(blockId: string): Promise<NotionAsset | null>;
  notionUpdateBlock?(body: NotionUpdateBlockBody): Promise<NotionPageMutationResult>;
  notionAppendBlock?(body: NotionAppendBlockBody): Promise<NotionPageMutationResult>;
  notionDeleteBlock?(body: NotionDeleteBlockBody): Promise<NotionPageMutationResult>;
  notionMoveBlock?(body: NotionMoveBlockBody): Promise<NotionPageMutationResult>;
  notionDuplicateBlock?(body: NotionDuplicateBlockBody): Promise<NotionPageMutationResult>;
  notionPatchTitle?(body: NotionPatchTitleBody): Promise<NotionPageMutationResult>;
  notionCreatePage?(body: NotionCreatePageBody): Promise<NotionCreatePageResult>;
  notionArchivePage?(body: NotionArchivePageBody): Promise<NotionArchivePageResult>;
  events: EventSink;
}
