import type {
  DeviceRecord,
  Event,
  EventActor,
  TodoStatus,
  TopicStatus,
} from "@you-brain/protocol";

export interface SessionRecord {
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
}

export interface SessionUpsert {
  sessionKey: string;
  source: string;
  device: string;
  startedAt: string;
  updatedAt: string;
  fileId?: string | null;
  title?: string;
  summary?: string;
  msgCount?: number;
  refinedUpTo?: number;
  topicId?: string | null;
}

export interface TodayQuery {
  timeZone: string;
  now?: string | Date;
}

export interface SessionListQuery {
  /** Newest `updatedAt` first. Omit to return every row. */
  limit?: number;
  topicId?: string;
  /** Only sessions that still have turns the refine step has not seen. */
  unrefinedOnly?: boolean;
  /** Only sessions updated at or after this ISO timestamp. */
  updatedSince?: string;
}

export interface TopicRecord {
  topicId: string;
  name: string;
  aliases: string[];
  status: TopicStatus;
  statusBy: EventActor;
  summary: string;
  nextStep: string;
  lastActive: string | null;
  mergedInto: string | null;
  createdTs: string | null;
  lastUserOpAt: string | null;
  /** Newest moment the topic's own content changed. Reminder actions do not move it. */
  lastContentAt: string | null;
  userLocked: boolean;
}

export interface ConclusionRecord {
  conclusionId: string;
  topicId: string;
  sessionKey: string;
  text: string;
  ts: string;
}

export interface TodoRecord {
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

export interface DerivedSessionRow {
  sessionKey: string;
  source: string;
  fileId: string | null;
  title: string;
  summary: string;
  refinedUpTo: number;
  /** Newest refine event. Dates a session this device has no file for. Optional. */
  refinedAt?: string | null;
  topicId: string | null;
}

export interface DerivedSnapshot {
  topics: readonly TopicRecord[];
  sessions: readonly DerivedSessionRow[];
  conclusions: readonly ConclusionRecord[];
  todos: readonly TodoRecord[];
  events: readonly Event[];
  /**
   * When set, replaces the reminders table in the same transaction.
   * Omit it to leave reminders untouched.
   */
  reminders?: readonly ReminderRecord[];
}

export interface TopicBookPersistence {
  getSession(sessionKey: string): SessionRecord | null;
  replaceDerived(snapshot: DerivedSnapshot): void;
}

export type OutboxKind = "event" | "upload";
export type OutboxStatus = "pending" | "inflight" | "acked";

export interface OutboxInput {
  id: string;
  kind: OutboxKind;
  payload: unknown;
  createdAt?: string;
}

export interface OutboxRecord {
  id: string;
  kind: OutboxKind;
  payload: unknown;
  createdAt: string;
  attempts: number;
  status: OutboxStatus;
  ackedAt: string | null;
}

export interface PortraitRecord {
  variant: string;
  path: string;
  version: string;
  updatedAt: string;
}

export interface ReminderRecord {
  reminderId: string;
  kind: string;
  topicId: string | null;
  text: string;
  status: string;
  until: string | null;
  issuedAt: string;
  updatedAt: string;
}

export type { DeviceRecord };
