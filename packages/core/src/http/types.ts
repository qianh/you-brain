import {
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
  | { type: "conclusion.added"; data: EventOf<"conclusion.added">["data"] };

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
}

export interface SearchResponse {
  query: string;
  indexStatus: "fresh" | "stale";
  searchMode: "semantic" | "keyword";
  results: SearchHit[];
  warnings: Array<{ code: string; message: string }>;
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
  consolidation: {
    enabled: boolean;
    lastFinishedAt: string | null;
    stale: boolean;
    /** `disabled` is “未启用”. Stale is only computed when consolidation is enabled. */
    status: "disabled" | "ok" | "stale";
  };
  warnings: Array<{ code: string; message: string }>;
}

export interface ReminderView {
  reminderId: string;
  kind: string;
  topicId: string | null;
  text: string;
  status: string;
  until: string | null;
  issuedAt: string;
}

export interface RemindersResponse {
  reminders: ReminderView[];
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

export const DaemonEventSchema = z.object({
  id: z.number().int().nonnegative(),
  kind: z.enum(["ready", "topics", "today", "status"]),
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
