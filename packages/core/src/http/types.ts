import { SEARCH_PROVIDERS } from "../auth/search-secrets.js";
import { DSH_LOGIN_PROVIDER_IDS } from "../deck/dsh/login.js";
import {
  DeviceCapabilitySchema,
  IsoTimestampSchema,
  LlmProviderSchema,
  ReminderActionSchema,
  SessionKeySchema,
  TodoStatusSchema,
  TopicStatusSchema,
  type DeviceRecord,
  type EventActor,
  type EventOf,
  type EventType,
  type TodoStatus,
  type TopicStatus,
} from "@you-brain/protocol";

import { SessionSourceSchema } from "../domain/session.js";
import { WebhookEventKindSchema, type WebhookEventKind } from "../webhook/kinds.js";
import type { NotionBlockModel } from "../notion/model.js";

export type { NotionBlockModel, NotionSegment } from "../notion/model.js";

export const NotionSegmentSchema = z.object({
  text: z.string(),
  href: z.string().nullable(),
  bold: z.boolean(),
  italic: z.boolean(),
  strikethrough: z.boolean(),
  underline: z.boolean(),
  code: z.boolean(),
  color: z.string(),
  mention: z.record(z.string(), z.unknown()).optional(),
  equation: z.string().max(2_000).optional(),
});
import { z } from "zod";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface ConclusionView {
  conclusionId: string;
  topicId: string;
  sessionKey: string;
  text: string;
  ts: string;
}

export interface TodoView {
  todoId: string;
  topicId: string;
  sessionKey: string;
  text: string;
  status: TodoStatus;
  statusBy: EventActor;
  confidence: number;
  ts: string;
  userLocked: boolean;
}

export interface TodaySession {
  sessionKey: string;
  source: string;
  device: string;
  fileId: string | null;
  title: string;
  summary: string;
  startedAt: string | null;
  updatedAt: string | null;
  msgCount: number;
  refinedUpTo: number;
  topicId: string | null;
  topicName: string | null;
  conclusions: ConclusionView[];
  todos: TodoView[];
}

export interface TodayResponse {
  date: string;
  timeZone: string;
  sessions: TodaySession[];
}

export interface TopicListItem {
  topicId: string;
  name: string;
  aliases: string[];
  status: TopicStatus;
  statusBy: EventActor;
  summary: string;
  nextStep: string;
  lastActive: string | null;
  zone: "active" | "history";
  createdTs: string | null;
  lastUserOpAt: string | null;
  userLocked: boolean;
  openTodoCount: number;
  sessionCount?: number;
}

export interface TopicsQuery {
  zone?: "active" | "history";
  status?: TopicStatus;
}

export interface TopicsResponse {
  topics: TopicListItem[];
}

export interface TopicSessionLink {
  sessionKey: string;
  source: string;
  device: string;
  fileId: string | null;
  title: string;
  summary: string;
  updatedAt: string | null;
}

export interface TopicDetail {
  topicId: string;
  name: string;
  aliases: string[];
  status: TopicStatus;
  statusBy: EventActor;
  summary: string;
  nextStep: string;
  lastActive: string | null;
  zone: "active" | "history";
  mergedInto: string | null;
  createdTs: string | null;
  lastUserOpAt: string | null;
  userLocked: boolean;
  conclusions: ConclusionView[];
  todos: TodoView[];
  sessions: TopicSessionLink[];
}

export type UserEvent =
  | { type: "topic.renamed"; data: EventOf<"topic.renamed">["data"] }
  | { type: "topic.status_changed"; data: EventOf<"topic.status_changed">["data"] }
  | { type: "topic.merged"; data: EventOf<"topic.merged">["data"] }
  | { type: "topic.unassigned"; data: EventOf<"topic.unassigned">["data"] }
  | { type: "topic.assigned"; data: EventOf<"topic.assigned">["data"] }
  | { type: "topic.created"; data: EventOf<"topic.created">["data"] }
  | { type: "todo.status_changed"; data: EventOf<"todo.status_changed">["data"] }
  | { type: "conclusion.added"; data: EventOf<"conclusion.added">["data"] }
  | { type: "reminder.action"; data: EventOf<"reminder.action">["data"] }
  | { type: "portrait.correction"; data: EventOf<"portrait.correction">["data"] };

export interface ActionResponse {
  ok: true;
  events: UserEvent[];
}

export interface TopicMutationResponse extends ActionResponse {
  topicId: string;
}

const AliasesSchema = z.array(z.string().min(1));

export const RenameTopicBodySchema = z.object({
  op: z.literal("rename"),
  name: z.string().min(1),
  aliases: AliasesSchema.optional(),
});

export const StatusTopicBodySchema = z.object({
  op: z.literal("status"),
  status: TopicStatusSchema,
});

export const MergeTopicBodySchema = z.object({
  op: z.literal("merge"),
  intoTopicId: z.string().min(1),
});

export const SplitTopicBodySchema = z.object({
  op: z.literal("split"),
  sessionKey: SessionKeySchema,
  target: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("assign"),
      topicId: z.string().min(1),
    }),
    z.object({
      action: z.literal("create"),
      name: z.string().min(1),
      aliases: AliasesSchema.optional(),
    }),
  ]),
});

export const TopicMutationBodySchema = z.discriminatedUnion("op", [
  RenameTopicBodySchema,
  StatusTopicBodySchema,
  MergeTopicBodySchema,
  SplitTopicBodySchema,
]);

export type TopicMutationBody = z.infer<typeof TopicMutationBodySchema>;

export const TopicReorganizePlanBodySchema = z.object({
  /** Discard the plan the daemon is holding and make a new one. */
  refresh: z.boolean().optional(),
});

export const TopicReorganizeApplyBodySchema = z.object({
  groups: z.array(
    z.object({
      intoTopicId: z.string().min(1),
      fromTopicIds: z.array(z.string().min(1)).min(1),
      name: z.string(),
      archive: z.boolean(),
    }),
  ),
});

export type TopicReorganizeApplyBody = z.infer<typeof TopicReorganizeApplyBodySchema>;

export interface TopicReorganizeMember {
  topicId: string;
  name: string;
  sessionCount: number;
}

export interface TopicReorganizeGroup {
  name: string;
  reason: string;
  intoTopicId: string;
  /** The survivor comes first. */
  members: TopicReorganizeMember[];
  archive: boolean;
}

export interface TopicReorganizePlan {
  topicCount: number;
  reviewedCount: number;
  topicCountAfter: number;
  groups: TopicReorganizeGroup[];
}

/** What the daemon knows about the plan. `queued` is waiting behind other model calls. */
export type TopicReorganizeStatus =
  | { state: "idle" }
  | { state: "queued" | "running"; startedAt: string }
  | { state: "ready"; plan: TopicReorganizePlan }
  | { state: "failed"; message: string };

export interface TopicReorganizeResult {
  merged: number;
}

export const TodoActionBodySchema = z.object({
  todoId: z.string().min(1),
  status: TodoStatusSchema,
});

export type TodoActionBody = z.infer<typeof TodoActionBodySchema>;

export const ConclusionActionBodySchema = z.object({
  topicId: z.string().min(1),
  text: z.string().min(1),
  sessionKey: SessionKeySchema,
});

export type ConclusionActionBody = z.infer<typeof ConclusionActionBodySchema>;

export const ReminderActionBodySchema = z.object({
  reminderId: z.string().min(1),
  action: ReminderActionSchema,
  until: IsoTimestampSchema.optional(),
});

export type ReminderActionBody = z.infer<typeof ReminderActionBodySchema>;

export const ActivityBodySchema = z.object({
  at: IsoTimestampSchema.optional(),
});

export type ActivityBody = z.infer<typeof ActivityBodySchema>;

export interface PortraitResponse {
  variant: string;
  content: string;
  path: string;
  updatedAt: string | null;
}

export interface PortraitSnapshot {
  name: string;
  path: string;
  updatedAt: string | null;
}

export interface PortraitSnapshotsResponse {
  snapshots: PortraitSnapshot[];
}

export interface PortraitCorrectionView {
  correctionId: string;
  variant: string;
  section: string;
  text: string;
  createdAt: string;
  status: "pending" | "applied";
  snapshot?: string;
}

export interface PortraitCorrectionsResponse {
  corrections: PortraitCorrectionView[];
}

export const PortraitCorrectionBodySchema = z.object({
  variant: z.string().optional(),
  section: z.string(),
  text: z.string(),
});

export type PortraitCorrectionBody = z.infer<typeof PortraitCorrectionBodySchema>;

export interface PortraitCorrectionResult {
  ok: true;
  correction: PortraitCorrectionView;
}

export interface SearchRequest {
  query: string;
  limit?: number;
  from?: string;
  to?: string;
  sources?: string[];
}

export interface SearchHit {
  score: number;
  source: string;
  conversationId: string;
  startedAt: string;
  updatedAt: string;
  excerpt: string;
  /** Present for a session that lives only on another device's Drive folder. */
  device?: string;
  driveFileId?: string;
}

export interface SearchResponse {
  query: string;
  indexStatus: "fresh" | "stale";
  searchMode: "semantic" | "keyword";
  results: SearchHit[];
  warnings: Array<{ code: string; message: string }>;
}

export const VirtualDeviceCreateBodySchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  capabilities: z.array(DeviceCapabilitySchema).optional(),
});

export type VirtualDeviceCreateBody = z.infer<typeof VirtualDeviceCreateBodySchema>;

export interface VirtualDeviceResponse {
  device: DeviceRecord;
}

export interface RemoveDeviceResponse {
  ok: true;
}

export interface DevicesResponse {
  devices: DeviceRecord[];
}

export interface StatusResponse {
  deviceId: string | null;
  drive: {
    reachable: boolean | null;
    accountEmail: string | null;
  };
  sync: {
    lastSyncAt: string | null;
    pendingOutbox: number;
    /** 会话维度积压：未同步事件涉及的不同会话数。可能与 pendingOutbox 差几十倍。 */
    pendingOutboxSessions: number;
    /** Set after a failed pull. Cleared by the next successful pull. Absent on older daemons. */
    lastError?: string | null;
    lastErrorAt?: string | null;
  };
  search: {
    ready: boolean;
    documents: number;
  };
  refine: {
    pending: number;
    lastError: string | null;
  };
  capture?: {
    /** Session files parsed by the last scan. Zero means every file was unchanged. */
    parsed: number;
  };
  /**
   * Per-source capture state: the newest session each source holds and how many.
   * Absent on older daemons; the status page then shows every source as never captured.
   */
  captures?: Array<{
    source: string;
    lastCaptureAt: string | null;
    sessionCount: number;
  }>;
  upload?: {
    /** Sessions waiting in the live map: captured but not yet on Drive. */
    pending: number;
    /** Milliseconds the slowest upload of this process took. */
    slowestMs: number;
    /** Consecutive failed upload passes. Reset by a successful one. */
    failures: number;
    /** Reason of the last upload failure, if any. */
    lastError: string | null;
  };
  consolidation: {
    enabled: boolean;
    lastFinishedAt: string | null;
    stale: boolean;
    /** `disabled` is “未启用”. Stale is only computed when consolidation is enabled. */
    status: "disabled" | "ok" | "stale";
    /** Present after this process has attempted a run. Memory only. */
    lastRun?: {
      day: string;
      ok: boolean;
      error?: string;
      finishedAt: string;
    };
  };
  web: {
    /** Resolved processor: `webProcessor`, otherwise `mainDevice`. */
    processor: string | null;
    isLocalProcessor: boolean;
    /** Unrefined web sessions. Computed only on the processor; otherwise 0. */
    pending: number;
  };
  warnings: Array<{ code: string; message: string }>;
  /**
   * 无界面机器上正在进行的一次登录。登录接口会阻塞到用户完成授权，
   * 所以授权链接只能从状态里拿，界面才能把它显示出来。
   */
  login?: {
    authorizationUrl: string;
    /** `ssh -L` 隧道命令；无法推断时为空。 */
    tunnel: string | null;
  };
}

export interface ReminderView {
  reminderId: string;
  kind: string;
  topicId: string | null;
  topicName?: string | null;
  text: string;
  status: string;
  until: string | null;
  issuedAt: string;
}

export interface ReminderDelivery {
  notify: boolean;
  reason: "ok" | "disabled" | "inactive" | "other-device";
}

export interface RemindersResponse {
  reminders: ReminderView[];
  /** Daemon HTTP only. MCP `get_reminders` omits this. */
  delivery?: ReminderDelivery;
}

export const UploadActionBodySchema = z.object({
  sources: z.array(SessionSourceSchema).optional(),
  backfill: z.boolean().optional(),
  includeSubagents: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export type UploadActionInput = z.infer<typeof UploadActionBodySchema>;

export interface UploadActionResult {
  dryRun: boolean;
  scanned: number;
  uploaded: number;
  warnings: Array<{ code: string; message: string }>;
}

export interface SyncActionResult {
  started: boolean;
  at: string;
}

export const ConsolidateActionBodySchema = z.object({
  force: z.boolean().optional(),
});

export type ConsolidateActionInput = z.infer<typeof ConsolidateActionBodySchema>;

export interface ConsolidateStepResult {
  id: string;
  ok: boolean;
  error?: string;
}

export interface ConsolidateActionResult {
  day: string;
  ok: boolean;
  steps: ConsolidateStepResult[];
}

export const WebhookPutSchema = z
  .object({
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    secret: z.string().optional(),
    events: z.array(WebhookEventKindSchema).optional(),
  })
  .strict();

export type WebhookPutBody = z.infer<typeof WebhookPutSchema>;

export const WebhookLastSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  status: z.number().int().optional(),
  error: z.string().optional(),
  eventId: z.string().optional(),
});

export const WebhookPublicSchema = z.object({
  enabled: z.boolean(),
  url: z.string(),
  hasSecret: z.boolean(),
  events: z.array(WebhookEventKindSchema),
  active: z.boolean(),
  last: WebhookLastSchema.nullable(),
  pending: z.number().int().nonnegative(),
});

export type WebhookPublic = z.infer<typeof WebhookPublicSchema>;

export const WebhookTestResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().int().optional(),
  error: z.string().optional(),
});

export type WebhookTestResult = z.infer<typeof WebhookTestResultSchema>;

/** PUT /api/secrets/llm. The key goes to the OS keychain and is never echoed back. */
export const LlmKeyPutSchema = z
  .object({
    provider: LlmProviderSchema,
    apiKey: z.string().trim().min(1),
  })
  .strict();

export type LlmKeyPutBody = z.infer<typeof LlmKeyPutSchema>;

export const LlmTestBodySchema = z
  .object({
    provider: LlmProviderSchema,
    model: z.string(),
    baseUrl: z.string(),
  })
  .strict();

export type LlmTestBody = z.infer<typeof LlmTestBodySchema>;

/** Response for both secret PUTs. Carries no secret value. */
export interface SecretStoredResponse {
  stored: true;
  echoed: false;
  hasSecret: boolean;
}

export interface LlmTestResult {
  ok: boolean;
  message: string;
}

/** Response of POST /api/actions/google-login. `message` is shown to the user as-is. */
export interface GoogleLoginResult {
  ok: boolean;
  message: string;
  /**
   * 无界面机器上的授权链接与隧道命令。登录要等用户在别处完成，所以先返回这个，
   * 界面自己展示；没有这个字段时说明浏览器已经在本机打开。
   */
  authorization?: {
    url: string;
    tunnel: string | null;
  };
}

/** Response of POST /api/actions/google-logout and google-switch. `message` is shown as-is. */
export interface GoogleLogoutResult {
  ok: boolean;
  message: string;
}

/**
 * GET/PUT /api/oauth-client.
 *
 * 只暴露 client id 和是否有 secret，secret 本身永远不回显。
 * `mode` 为 custom 时表示这台机器用自己的 Google Cloud 项目。
 */
export const OAuthClientPublicSchema = z.object({
  mode: z.enum(["official", "custom"]),
  clientId: z.string(),
  hasClientSecret: z.boolean(),
  /** 当前构建是否内置了官方凭据。没有内置时只能走 custom。 */
  officialAvailable: z.boolean(),
});

export type OAuthClientPublic = z.infer<typeof OAuthClientPublicSchema>;

/** PUT /api/oauth-client。两个字段都可省略：只改 id 时不必重贴 secret。 */
export const OAuthClientPutSchema = z
  .object({
    mode: z.enum(["official", "custom"]),
    clientId: z.string().trim().max(200).optional(),
    clientSecret: z.string().trim().max(500).optional(),
  })
  .strict();

export type OAuthClientPutBody = z.infer<typeof OAuthClientPutSchema>;

// ---------------------------------------------------------------------------
// Notion(知识库,Notion 数据接入,只读)
// ---------------------------------------------------------------------------

export interface NotionStatusView {
  hasToken: boolean;
  pages: number;
  lastSyncAt: string | null;
  lastError: string | null;
  syncing: boolean;
  lastRun?: {
    objectsSeen: number;
    pagesSynced: number;
    databasesSynced: number;
    removed: number;
    failed: number;
    pending: number;
    error: string | null;
  };
}

/** PUT /api/secrets/notion。集成令牌进系统钥匙串,永远不回显。 */
export const NotionKeyPutSchema = z
  .object({ token: z.string().trim().min(10) })
  .strict();

export type NotionKeyPutBody = z.infer<typeof NotionKeyPutSchema>;

/** PUT /api/secrets/search。第三方搜索服务（给指挥台挂搜索 MCP）的 Key 进系统钥匙串,永远不回显。 */
export const SearchKeyPutSchema = z
  .object({
    provider: z.enum(SEARCH_PROVIDERS),
    apiKey: z.string().trim().min(1),
  })
  .strict();

export type SearchKeyPutBody = z.infer<typeof SearchKeyPutSchema>;

/** PUT /api/search-provider。启用哪个第三方搜索；null = 都不启用，走 DeepSeek 默认。 */
export const SearchActivePutSchema = z
  .object({ active: z.enum(SEARCH_PROVIDERS).nullable() })
  .strict();

export type SearchActivePutBody = z.infer<typeof SearchActivePutSchema>;

/** GET /api/search-provider。只说启用了谁、各家有没有 Key，不含 Key。 */
export interface SearchSettings {
  active: (typeof SEARCH_PROVIDERS)[number] | null;
  providers: Record<(typeof SEARCH_PROVIDERS)[number], { hasKey: boolean }>;
}

export interface NotionTestResult {
  ok: boolean;
  name?: string;
  workspaceName?: string | null;
  error?: string;
}

export interface NotionSyncResult {
  objectsSeen: number;
  pagesSynced: number;
  databasesSynced: number;
  removed: number;
  failed: number;
  pending: number;
  error: string | null;
}

export interface NotionTreeNodeView {
  id: string;
  object: "page" | "database";
  title: string;
  icon: string | null;
  children: NotionTreeNodeView[];
}

export interface NotionTreeView {
  roots: NotionTreeNodeView[];
}

export interface NotionSearchHitView {
  pageId: string;
  title: string;
  excerpt: string;
}

export interface NotionSearchView {
  query: string;
  hits: NotionSearchHitView[];
}

export interface NotionDatabaseView {
  databaseId: string;
  title: string;
  /** options:单选/多选/状态列的可选值。 */
  columns: Array<{ name: string; type: string; options?: string[] }>;
  rows: Array<{
    id: string;
    title: string;
    icon: string | null;
    cells: Array<{ name: string; type: string; text: string }>;
  }>;
}

export interface NotionAsset {
  bytes: Uint8Array;
  contentType: string;
}

/** POST /api/actions/notion-update-block。返回刷新后的页面视图。 */
export const NotionUpdateBlockSchema = z
  .object({
    blockId: z.string().min(1),
    markdown: z.string().max(20_000),
    /** turn-into:同时切换块类型。 */
    kind: z
      .enum(["paragraph", "heading1", "heading2", "heading3", "bulleted", "numbered", "todo", "quote", "callout", "toggle", "code"])
      .optional(),
    /** to_do 勾选覆盖;省略时保持原状。 */
    checked: z.boolean().optional(),
    /** 所见即所得编辑直接提交富文本段落;省略时按 markdown 解析。 */
    rich: z.array(NotionSegmentSchema).max(200).optional(),
    /** 代码块语言覆盖;省略时保持原状。 */
    language: z.string().max(64).optional(),
  })
  .strict();

export type NotionUpdateBlockBody = z.infer<typeof NotionUpdateBlockSchema>;

const NotionNewBlockKindSchema = z.enum([
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulleted",
  "numbered",
  "todo",
  "quote",
  "callout",
  "toggle",
  "code",
  "divider",
]);

/** 粘贴 Markdown 表格:第一行是否表头;每行一组单元格,每格是富文本。超过 100 行由 core 分批续写。 */
const NotionNewTableSchema = z
  .object({
    hasHeader: z.boolean(),
    rows: z
      .array(z.array(z.array(NotionSegmentSchema).max(100)).min(1).max(100))
      .min(1)
      .max(5_000),
  })
  .strict();

/** 追加时一个新块的描述;children 是嵌套子块(Notion 单次请求最多嵌两层)。 */
export const NotionNewChildSchema = z
  .object({
    kind: z.enum([...NotionNewBlockKindSchema.options, "table"]),
    markdown: z.string().max(20_000),
    rich: z.array(NotionSegmentSchema).max(200).optional(),
    language: z.string().max(40).optional(),
    checked: z.boolean().optional(),
    /** callout 的图标。 */
    emoji: z.string().max(16).optional(),
    /** kind 为 table 时必填。 */
    table: NotionNewTableSchema.optional(),
    get children() {
      return z.array(NotionNewChildSchema).max(100).optional();
    },
  })
  .strict();

export type NotionNewChildBody = z.infer<typeof NotionNewChildSchema>;

/** POST /api/actions/notion-append-block。 */
export const NotionAppendBlockSchema = z
  .object({
    pageId: z.string().min(1).optional(),
    afterBlockId: z.string().min(1).optional(),
    /** 追加为这个块的子块(缩进);不带 afterBlockId 时放在它的子块末尾。 */
    parentBlockId: z.string().min(1).optional(),
    markdown: z.string().max(20_000),
    kind: NotionNewBlockKindSchema.optional(),
    rich: z.array(NotionSegmentSchema).max(200).optional(),
    /** 一次追加多个块(粘贴 Markdown、缩进):给了它就忽略上面的 kind/markdown/rich。Notion 单次最多 100 个。 */
    children: z.array(NotionNewChildSchema).min(1).max(100).optional(),
    /** 插到最前面(标题上按回车新起正文第一行);不能与 afterBlockId 同用。 */
    atStart: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.pageId !== undefined || value.afterBlockId !== undefined || value.parentBlockId !== undefined,
    { message: "缺少 pageId、afterBlockId 或 parentBlockId" },
  );

export type NotionAppendBlockBody = z.infer<typeof NotionAppendBlockSchema>;

const NotionTableCellsSchema = z.array(z.array(NotionSegmentSchema).max(100)).min(1).max(100);

/**
 * POST /api/actions/notion-table-edit:表格的单元格与行列编辑。行按下标定位(前端与 core 的写入
 * 走同一条串行队列,下标一致);增删列要整表重建(Notion 建表后不能改列数),表格块 id 会变。
 */
export const NotionTableEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update-row"), tableId: z.string().min(1), rowIndex: z.number().int().min(0), cells: NotionTableCellsSchema }).strict(),
  z.object({ op: z.literal("insert-row"), tableId: z.string().min(1), afterIndex: z.number().int().min(-1), cells: NotionTableCellsSchema }).strict(),
  z.object({ op: z.literal("delete-row"), tableId: z.string().min(1), rowIndex: z.number().int().min(0) }).strict(),
  z.object({ op: z.literal("set-header"), tableId: z.string().min(1), hasHeader: z.boolean().optional(), hasRowHeader: z.boolean().optional() }).strict(),
  z
    .object({
      op: z.literal("rebuild"),
      tableId: z.string().min(1),
      hasHeader: z.boolean(),
      hasRowHeader: z.boolean(),
      rows: z.array(NotionTableCellsSchema).min(1).max(5_000),
    })
    .strict(),
]);

export type NotionTableEditBody = z.infer<typeof NotionTableEditSchema>;

/** 前端发来的块模型(新建/修改用):形状由 core 的 sanitizeModel 收敛,这里只限大小。 */
const NotionModelInputSchema: z.ZodType<Record<string, unknown>> = z
  .object({ kind: z.string().min(1).max(40) })
  .passthrough()
  .refine((value) => JSON.stringify(value).length <= 2_000_000, { message: "块内容太大" });

const NotionPlacementShape = {
  afterBlockId: z.string().min(1).optional(),
  parentBlockId: z.string().min(1).optional(),
  atStart: z.boolean().optional(),
};

/** POST /api/actions/notion-relocate-blocks:移动或复制一组块(带子树);转类型时 root 覆盖第一个块的内容。 */
export const NotionRelocateBlocksSchema = z
  .object({
    blockIds: z.array(z.string().min(1)).min(1).max(100),
    mode: z.enum(["move", "copy"]),
    ...NotionPlacementShape,
    root: NotionModelInputSchema.optional(),
    /** 移到另一个页面(「移动到」)。 */
    targetPageId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.afterBlockId !== undefined || value.parentBlockId !== undefined || value.atStart !== undefined || value.targetPageId !== undefined,
    { message: "缺少目标位置" },
  );

export type NotionRelocateBlocksBody = z.infer<typeof NotionRelocateBlocksSchema>;

/** POST /api/actions/notion-patch-block:改块内容或属性(颜色、可折叠、图标、链接、说明、公式),类型不变。 */
export const NotionPatchBlockSchema = z.object({ blockId: z.string().min(1), model: NotionModelInputSchema }).strict();

export type NotionPatchBlockBody = z.infer<typeof NotionPatchBlockSchema>;

/** POST /api/actions/notion-create-blocks:新建任意类型的块(带子树)。 */
export const NotionCreateBlocksSchema = z
  .object({ models: z.array(NotionModelInputSchema).min(1).max(100), pageId: z.string().min(1).optional(), ...NotionPlacementShape })
  .strict()
  .refine((value) => value.pageId !== undefined || value.afterBlockId !== undefined || value.parentBlockId !== undefined, {
    message: "缺少 pageId、afterBlockId 或 parentBlockId",
  });

export type NotionCreateBlocksBody = z.infer<typeof NotionCreateBlocksSchema>;

/** POST /api/actions/notion-restore-blocks:撤销删除,恢复归档的块到原位置。 */
export const NotionRestoreBlocksSchema = z
  .object({ blockIds: z.array(z.string().min(1)).min(1).max(100), pageId: z.string().min(1), ...NotionPlacementShape })
  .strict();

export type NotionRestoreBlocksBody = z.infer<typeof NotionRestoreBlocksSchema>;

/** POST /api/actions/notion-upload-file:上传文件(≤20 MB,base64),返回 file_upload id。 */
export const NotionUploadFileSchema = z
  .object({
    filename: z.string().min(1).max(300),
    contentType: z.string().max(200),
    dataBase64: z.string().min(1).max(28_000_000),
  })
  .strict();

export type NotionUploadFileBody = z.infer<typeof NotionUploadFileSchema>;

const NotionFileRefSchema = z.union([
  z.object({ url: z.string().url().max(2_000) }).strict(),
  z.object({ uploadId: z.string().min(1) }).strict(),
]);

/** POST /api/actions/notion-page-meta:页面图标与封面;null 表示移除。 */
export const NotionPageMetaSchema = z
  .object({
    pageId: z.string().min(1),
    icon: z.union([z.object({ emoji: z.string().min(1).max(16) }).strict(), NotionFileRefSchema]).nullable().optional(),
    cover: NotionFileRefSchema.nullable().optional(),
  })
  .strict();

export type NotionPageMetaBody = z.infer<typeof NotionPageMetaSchema>;

/** POST /api/actions/notion-duplicate-page:复制页面(正文一起)。 */
export const NotionDuplicatePageSchema = z.object({ pageId: z.string().min(1), suffix: z.string().max(40) }).strict();

export type NotionDuplicatePageBody = z.infer<typeof NotionDuplicatePageSchema>;

/** POST /api/actions/notion-create-database:在页面里新建数据库。 */
export const NotionCreateDatabaseSchema = z.object({ pageId: z.string().min(1), title: z.string().max(200), inline: z.boolean() }).strict();

export type NotionCreateDatabaseBody = z.infer<typeof NotionCreateDatabaseSchema>;

/** POST /api/actions/notion-db-cell:改数据库单元格。 */
export const NotionDbCellSchema = z
  .object({
    databaseId: z.string().min(1),
    rowId: z.string().min(1),
    property: z.string().min(1).max(200),
    value: z.union([z.string().max(2_000), z.boolean(), z.array(z.string().max(100)).max(100), z.null()]),
  })
  .strict();

export type NotionDbCellBody = z.infer<typeof NotionDbCellSchema>;

/** POST /api/actions/notion-db-schema:新增/改名/删除数据库的列。 */
export const NotionDbSchemaSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add"),
      databaseId: z.string().min(1),
      name: z.string().min(1).max(100),
      type: z.enum(["rich_text", "number", "select", "multi_select", "date", "checkbox", "url", "email", "phone_number"]),
    })
    .strict(),
  z.object({ op: z.literal("rename"), databaseId: z.string().min(1), name: z.string().min(1).max(200), newName: z.string().min(1).max(100) }).strict(),
  z.object({ op: z.literal("delete"), databaseId: z.string().min(1), name: z.string().min(1).max(200) }).strict(),
]);

export type NotionDbSchemaBody = z.infer<typeof NotionDbSchemaSchema>;

/** POST /api/actions/notion-db-add-row。 */
export const NotionDbAddRowSchema = z.object({ databaseId: z.string().min(1), title: z.string().max(2_000) }).strict();

export type NotionDbAddRowBody = z.infer<typeof NotionDbAddRowSchema>;

/** POST /api/actions/notion-db-delete-row。 */
export const NotionDbDeleteRowSchema = z.object({ databaseId: z.string().min(1), rowId: z.string().min(1) }).strict();

export type NotionDbDeleteRowBody = z.infer<typeof NotionDbDeleteRowSchema>;

export interface NotionBlocksCreatedResult {
  page: NotionPageView;
  /** 新建块的模型(带真实 id 与子树),与请求里的块按顺序一一对应。 */
  created: NotionBlockModel[];
  /** 移动/复制:原块 id → 新块 id(整棵子树)。 */
  idMap?: Array<[string, string]>;
}

export const NotionDeleteBlockSchema = z
  .object({ blockId: z.string().min(1) })
  .strict();

export type NotionDeleteBlockBody = z.infer<typeof NotionDeleteBlockSchema>;

export const NotionMoveBlockSchema = z
  .object({ blockId: z.string().min(1), direction: z.enum(["up", "down"]) })
  .strict();

export type NotionMoveBlockBody = z.infer<typeof NotionMoveBlockSchema>;

export const NotionDuplicateBlockSchema = z
  .object({ blockId: z.string().min(1) })
  .strict();

export type NotionDuplicateBlockBody = z.infer<typeof NotionDuplicateBlockSchema>;

export const NotionPatchTitleSchema = z
  .object({ pageId: z.string().min(1), title: z.string().min(1).max(2_000) })
  .strict();

export type NotionPatchTitleBody = z.infer<typeof NotionPatchTitleSchema>;

export const NotionCreatePageSchema = z
  .object({
    parentId: z.string().min(1).optional(),
    title: z.string().min(1).max(2_000),
  })
  .strict();

export type NotionCreatePageBody = z.infer<typeof NotionCreatePageSchema>;

export const NotionArchivePageSchema = z
  .object({ pageId: z.string().min(1) })
  .strict();

export type NotionArchivePageBody = z.infer<typeof NotionArchivePageSchema>;

/** POST /api/actions/notion-move-page:把页面移到另一个页面下。 */
export const NotionMovePageSchema = z
  .object({ pageId: z.string().min(1), parentId: z.string().min(1) })
  .strict();

export type NotionMovePageBody = z.infer<typeof NotionMovePageSchema>;

export interface NotionPageMutationResult {
  page: NotionPageView;
}

export interface NotionCreatePageResult {
  pageId: string;
  view: NotionPageView | null;
}

export interface NotionArchivePageResult {
  roots: NotionTreeNodeView[];
}

/** 同步后的页面视图:块渲染模型 + 给 LLM/MCP 用的 markdown。 */
export interface NotionPageView {
  id: string;
  title: string;
  icon: string | null;
  coverUrl: string | null;
  lastEditedTime: string;
  blocks: NotionBlockModel[];
  markdown: string;
  /** 数据库行的属性(已拍平),普通页面没有这个字段。 */
  properties?: Record<string, string>;
  /** 数据库行:所在数据库和它的列(页面顶部可直接改属性)。 */
  database?: { id: string; columns: Array<{ name: string; type: string; options?: string[] }> };
}

export type { WebhookEventKind };

export const DaemonEventSchema = z.object({
  id: z.number().int().nonnegative(),
  kind: z.enum(["ready", "topics", "today", "status", "portrait", "devices", "notion"]),
  at: z.string().min(1),
});

export type DaemonEvent = z.infer<typeof DaemonEventSchema>;

export type DaemonChangeKind = Exclude<DaemonEvent["kind"], "ready">;

export const DaemonEndpointSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().min(16),
  pid: z.number().int().positive(),
});

export type DaemonEndpoint = z.infer<typeof DaemonEndpointSchema>;

export interface ZoneSettings {
  timeZone: string;
  activeLimit: number;
  historyDays: number;
  now?: () => Date;
}

export interface EventSink {
  emit<T extends EventType>(
    type: T,
    data: EventOf<T>["data"],
  ): void | Promise<void>;
}

// ---- 指挥台（deck）：界面、主控、任务都由 DSH 承担，daemon 只提供下面这些 ----

/** 指挥台标签页嵌入的 DSH Web 界面的状态；ready 时 url 带一次性访问令牌，仅限本机。 */
export type DeckDshWebResponse = import("../deck/dsh/web.js").DshWebState;

export const DeckBridgeSendBodySchema = z.object({
  app: z.string().min(1).max(60),
  prompt: z.string().min(1).max(20_000),
});

export const DeckBridgeRepliesBodySchema = z.object({
  app: z.string().min(1).max(60),
  sinceMs: z.number().int().nonnegative(),
});

export type DeckBridgeSendBody = z.infer<typeof DeckBridgeSendBodySchema>;
export type DeckBridgeRepliesBody = z.infer<typeof DeckBridgeRepliesBodySchema>;

export interface DeckBridgeAppsResponse {
  apps: Array<{ id: string; displayName: string; available: boolean; detail: string; recoverable: boolean }>;
}

export interface DeckBridgeSendResponse {
  sentAtMs: number;
  recoverable: boolean;
}

export interface DeckBridgeRepliesResponse {
  replies: string[];
}

export const DeckDshLoginBodySchema = z.object({
  action: z.enum(["start", "cancel", "logout"]),
  provider: z.enum(DSH_LOGIN_PROVIDER_IDS),
});

export type DeckDshLoginBody = z.infer<typeof DeckDshLoginBodySchema>;

/** 订阅登录状态：各供应商是否已登录、是否在等浏览器授权。 */
export interface DeckDshLoginResponse {
  providers: import("../deck/dsh/login.js").DshLoginView[];
}

