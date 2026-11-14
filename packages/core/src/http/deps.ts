import type { DeviceRecord, Roles, SharedConfig } from "@you-brain/protocol";

import type { EventSink } from "./types.js";
import type { TerminalConnection, TerminalSize, Tty7TerminalEvents } from "../deck/tty7-terminal.js";
import type {
  PortraitCorrectionView,
  PortraitResponse,
  PortraitSnapshot,
  ReminderView,
  RemindersResponse,
  SearchRequest,
  SearchResponse,
  SessionContentView,
  StatusResponse,
  LlmModelsView,
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
  NotionMovePageBody,
  NotionArchivePageResult,
  NotionAsset,
  NotionCreatePageBody,
  NotionCreatePageResult,
  NotionDatabaseView,
  NotionDeleteBlockBody,
  NotionTableEditBody,
  NotionDbCellBody,
  NotionCreateDatabaseBody,
  NotionDbSchemaBody,
  NotionDuplicatePageBody,
  NotionDbAddRowBody,
  NotionDbDeleteRowBody,
  NotionRelocateBlocksBody,
  NotionPatchBlockBody,
  NotionCreateBlocksBody,
  NotionRestoreBlocksBody,
  NotionUploadFileBody,
  NotionPageMetaBody,
  NotionBlocksCreatedResult,
  NotionDuplicateBlockBody,
  NotionKeyPutBody,
  SearchActivePutBody,
  SearchKeyPutBody,
  SearchSettings,
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
  DeckBridgeAppsResponse,
  DeckBridgeRepliesBody,
  DeckBridgeRepliesResponse,
  DeckBridgeSendBody,
  DeckBridgeSendResponse,
  DeckDshLoginBody,
  DeckDshLoginResponse,
  DeckDshWebResponse,
  DeckTty7ScreenResponse,
  DeckTty7PasteImageResponse,
  DeckTty7SendBody,
  DeckTty7SessionsResponse,
  DeckTty7StartBody,
  DeckTty7StartResponse,
  TopicReorganizeApplyBody,
  TopicReorganizeResult,
  TopicReorganizeStatus,
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
  /** 会话原文（Drive inbox，markdown）；Drive 未就绪时缺省。conversationId 与 sessionKey 任给一个。指挥台 @ 引用展开用。 */
  sessionContent?(input: { source: string; conversationId?: string; sessionKey?: string }): Promise<SessionContentView>;
  /** 供应商的可用模型（现在只有 magpie）；网关不可达时缺省或抛错，设置页退回手动填写。 */
  llmModels?(input: { provider: string; baseUrl?: string }): Promise<LlmModelsView>;
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
  /** 提醒被截短的原文(目前只有晨间摘要);没有更多内容为 null。 */
  reminderDetail?(id: string): Promise<{ detail: string | null }>;
  /** Record keyboard, pointer, or other local activity. `at` is already bounded. */
  reportActivity(at: string): Promise<{ at: string }>;
  now(): Date;
  sync(): Promise<SyncActionResult>;
  upload(input: UploadActionInput): Promise<UploadActionResult>;
  /** Optional so older test doubles keep compiling. The daemon always supplies it. */
  consolidate?(input: { force?: boolean }): Promise<ConsolidateActionResult>;
  /** Optional so older test doubles keep compiling. The daemon always supplies all three. */
  planTopicReorganization?(input: { refresh?: boolean }): TopicReorganizeStatus;
  topicReorganizeStatus?(): TopicReorganizeStatus;
  applyTopicReorganization?(body: TopicReorganizeApplyBody): Promise<TopicReorganizeResult>;
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
  searchSettings?(): Promise<SearchSettings>;
  writeSearchKey?(body: SearchKeyPutBody): Promise<void>;
  writeSearchActive?(body: SearchActivePutBody): Promise<void>;
  notionSync?(): Promise<NotionSyncResult>;
  notionTree?(): Promise<NotionTreeView>;
  notionPage?(pageId: string): Promise<NotionPageView | null>;
  notionSearch?(query: string, limit?: number): Promise<NotionSearchView>;
  notionUsers?(): Promise<Array<{ id: string; name: string }>>;
  notionDatabase?(databaseId: string): Promise<NotionDatabaseView | null>;
  notionAsset?(blockId: string): Promise<NotionAsset | null>;
  notionUpdateBlock?(body: NotionUpdateBlockBody): Promise<NotionPageMutationResult>;
  notionAppendBlock?(body: NotionAppendBlockBody): Promise<NotionPageMutationResult>;
  notionDeleteBlock?(body: NotionDeleteBlockBody): Promise<NotionPageMutationResult>;
  notionTableEdit?(body: NotionTableEditBody): Promise<NotionPageMutationResult>;
  notionRelocateBlocks?(body: NotionRelocateBlocksBody): Promise<NotionBlocksCreatedResult>;
  notionPatchBlock?(body: NotionPatchBlockBody): Promise<NotionPageMutationResult>;
  notionCreateBlocks?(body: NotionCreateBlocksBody): Promise<NotionBlocksCreatedResult>;
  notionRestoreBlocks?(body: NotionRestoreBlocksBody): Promise<NotionBlocksCreatedResult>;
  notionUploadFile?(body: NotionUploadFileBody): Promise<{ uploadId: string }>;
  notionPageMeta?(body: NotionPageMetaBody): Promise<NotionPageMutationResult>;
  notionDbCell?(body: NotionDbCellBody): Promise<NotionDatabaseView>;
  notionCreateDatabase?(body: NotionCreateDatabaseBody): Promise<{ page: NotionPageView; databaseId: string }>;
  notionDbSchema?(body: NotionDbSchemaBody): Promise<NotionDatabaseView>;
  notionDuplicatePage?(body: NotionDuplicatePageBody): Promise<NotionArchivePageResult & { pageId: string }>;
  notionDbAddRow?(body: NotionDbAddRowBody): Promise<NotionDatabaseView>;
  notionDbDeleteRow?(body: NotionDbDeleteRowBody): Promise<NotionDatabaseView>;
  notionMoveBlock?(body: NotionMoveBlockBody): Promise<NotionPageMutationResult>;
  notionDuplicateBlock?(body: NotionDuplicateBlockBody): Promise<NotionPageMutationResult>;
  notionPatchTitle?(body: NotionPatchTitleBody): Promise<NotionPageMutationResult>;
  notionCreatePage?(body: NotionCreatePageBody): Promise<NotionCreatePageResult>;
  notionArchivePage?(body: NotionArchivePageBody): Promise<NotionArchivePageResult>;
  notionMovePage?(body: NotionMovePageBody): Promise<NotionArchivePageResult>;
  /** 指挥台（deck）。The daemon always supplies it. */
  deck?: DeckHttpPort;
  events: EventSink;
}

/** 指挥台的 HTTP 端口。实现是 daemon 里的 DeckService。 */
export interface DeckHttpPort {
  /** 启动（若未运行）并返回嵌入页面用的 DSH Web 状态。 */
  dshWeb(retry?: boolean): Promise<DeckDshWebResponse>;
  dshLogin(): Promise<DeckDshLoginResponse>;
  dshLoginAction(body: DeckDshLoginBody): Promise<DeckDshLoginResponse>;
  /** GUI App 桥：给 DSH 的 u-brain-bridge 插件用。 */
  bridgeApps(): Promise<DeckBridgeAppsResponse>;
  bridgeSend(body: DeckBridgeSendBody): Promise<DeckBridgeSendResponse>;
  bridgeReplies(body: DeckBridgeRepliesBody): Promise<DeckBridgeRepliesResponse>;
  /** tty7 会话桥：列会话、看屏幕、发指令、新开会话；粘贴图片落盘换路径。 */
  tty7Sessions(): Promise<DeckTty7SessionsResponse>;
  tty7Delete(pane: number): Promise<{ ok: true }>;
  tty7Screen(pane: number, lines?: number): Promise<DeckTty7ScreenResponse>;
  tty7Send(body: DeckTty7SendBody): Promise<{ ok: true }>;
  tty7Start(body: DeckTty7StartBody): Promise<DeckTty7StartResponse>;
  tty7PasteImage(data: Uint8Array, contentType: string): Promise<DeckTty7PasteImageResponse>;
  tty7Terminal?(pane: number, size: TerminalSize, events: Tty7TerminalEvents): TerminalConnection;
}
