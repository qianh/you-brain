import type { DeviceRecord, Roles, SharedConfig } from "@you-brain/protocol";

import type { QuotaView } from "../quota/types.js";
import type { EventSink } from "./types.js";
import type { TaskHttpPort } from "../tasks/types.js";
import type { UiPrefs, UiPrefsPatch } from "../ui-prefs/store.js";
import type { TerminalConnection, TerminalSize, Tty7TerminalEvents } from "../deck/tty7-terminal.js";
import type {
  CodingProposalView,
  PortraitCorrectionView,
  PortraitProbeActionBody,
  PortraitProbeActionResult,
  PortraitProbeView,
  PortraitProposalActionBody,
  PortraitProposalActionResult,
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
  MorningDigestRegenerateResult,
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
  DeckMuseActionBody,
  DeckMuseActionResponse,
  DeckMuseOverviewResponse,
  DeckMuseSendBody,
  DeckMuseSendResponse,
  DeckMuseSessionResponse,
  DeckMuseStreamEvent,
  DeckNoticeDismissBody,
  DeckNoticesResponse,
  DeckTty7RenameBody,
  DeckTty7ViewingBody,
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
  tasks?: TaskHttpPort;
  today(): Promise<TodayResponse>;
  topics(query: TopicsQuery): Promise<TopicsResponse>;
  topic(id: string): Promise<TopicDetail | null>;
  todo(todoId: string): Promise<TodoView | null>;
  portrait(variant: string): Promise<PortraitResponse | null>;
  portraitSnapshots(): Promise<PortraitSnapshot[]>;
  portraitCorrections(variant?: string): Promise<PortraitCorrectionView[]>;
  portraitProposals?(): Promise<CodingProposalView[]>;
  reviewPortraitProposal?(body: PortraitProposalActionBody): Promise<PortraitProposalActionResult>;
  portraitProbes?(): Promise<PortraitProbeView[]>;
  reviewPortraitProbe?(body: PortraitProbeActionBody): Promise<PortraitProbeActionResult>;
  search(query: SearchRequest): Promise<SearchResponse>;
  /** Load the vector cache and the query model ahead of a likely search. Returns at once. */
  searchWarm?(): void;
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
  /** Last good read of the subscriptions' allowances; optional so older test doubles keep compiling. */
  quota?(): QuotaView;
  reminders(all: boolean): Promise<RemindersResponse>;
  reminder(id: string): Promise<ReminderView | null>;
  /** 提醒被截短的原文(目前只有晨间摘要);没有更多内容为 null。 */
  reminderDetail?(id: string): Promise<{ detail: string | null }>;
  /** 弹框提醒的回复:关闭提醒并记下这句话(只存本机)。可选,旧测试替身可不实现。 */
  reminderReply?(reminderId: string, text: string): Promise<ReminderView>;
  /** Record keyboard, pointer, or other local activity. `at` is already bounded. */
  reportActivity(at: string): Promise<{ at: string }>;
  now(): Date;
  sync(): Promise<SyncActionResult>;
  /** 可选,旧测试替身可不实现。daemon 总会提供。 */
  regenerateMorningDigest?(): Promise<MorningDigestRegenerateResult>;
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
  notionRecent?(limit?: number): Promise<Array<{ pageId: string; title: string; lastEditedTime: string }>>;
  notionUsers?(): Promise<Array<{ id: string; name: string }>>;
  notionDatabase?(databaseId: string): Promise<NotionDatabaseView | null>;
  /** 本地输出根目录（~/.you-brain），供物化引用文件写盘。 */
  outputDir?: string;
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
  /** 界面偏好（只认键和值）。页面来自随机端口，偏好存在 daemon 这边才能跨重启保留。 */
  uiPrefs: {
    read(): Promise<UiPrefs>;
    patch(input: UiPrefsPatch): Promise<UiPrefs>;
  };
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
  tty7Rename(body: DeckTty7RenameBody): Promise<{ ok: true }>;
  /** 网页上报正在整屏看的会话，这个会话的完成/等待提醒会被跳过。 */
  tty7Viewing(body: DeckTty7ViewingBody): Promise<{ ok: true }>;
  /** 终端会话提醒（工作中 → 等你回复/已完成）。 */
  notices(): Promise<DeckNoticesResponse>;
  noticeDismiss?(body: DeckNoticeDismissBody): Promise<{ ok: true }>;
  tty7Screen(pane: number, lines?: number): Promise<DeckTty7ScreenResponse>;
  tty7Send(body: DeckTty7SendBody): Promise<{ ok: true }>;
  tty7Start(body: DeckTty7StartBody): Promise<DeckTty7StartResponse>;
  tty7PasteImage(data: Uint8Array, contentType: string): Promise<DeckTty7PasteImageResponse>;
  tty7Terminal?(pane: number, size: TerminalSize, events: Tty7TerminalEvents): TerminalConnection;
  /** Muse SDK 会话桥：可选，旧测试替身可不提供。 */
  museOverview?(): Promise<DeckMuseOverviewResponse>;
  museSession?(id?: string): Promise<DeckMuseSessionResponse | null>;
  museAction?(body: DeckMuseActionBody): Promise<DeckMuseActionResponse>;
  museSend?(body: DeckMuseSendBody): Promise<DeckMuseSendResponse>;
  museSubscribe?(listener: (event: DeckMuseStreamEvent) => void): () => void;
}
