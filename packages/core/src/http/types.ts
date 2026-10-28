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

export type { WebhookEventKind };

export const DaemonEventSchema = z.object({
  id: z.number().int().nonnegative(),
  kind: z.enum(["ready", "topics", "today", "status", "portrait", "devices"]),
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
