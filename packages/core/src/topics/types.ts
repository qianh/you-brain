import type {
  Event,
  EventActor,
  TodoStatus,
  TopicStatus,
} from "@you-brain/protocol";

export interface SortKey {
  tsMs: number;
  device: string;
  seq: number;
  id: string;
}

export interface TopicState {
  topicId: string;
  name: string;
  aliases: string[];
  status: TopicStatus;
  statusBy: EventActor;
  summary: string;
  nextStep: string;
  mergedInto: string | null;
  createdTs: string | null;
  lastUserOpAt: string | null;
  userLocked: boolean;
}

export interface SessionState {
  sessionKey: string;
  source: string;
  fileId: string;
  title: string;
  summary: string;
  refinedUpTo: number;
  topicId: string | null;
}

export interface ConclusionState {
  conclusionId: string;
  topicId: string;
  sessionKey: string;
  text: string;
  ts: string;
}

export interface TodoState {
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

export interface TodoMemory extends TodoState {
  userStatusTs: string | null;
}

export interface FoldMemory {
  topics: Map<string, TopicState>;
  sessions: Map<string, SessionState>;
  conclusions: Map<string, ConclusionState>;
  todos: Map<string, TodoMemory>;
  parent: Map<string, string>;
  liveByName: Map<string, string>;
  ids: Set<string>;
  log: Event[];
  last: SortKey | null;
}

export interface TopicBook {
  readonly topics: readonly TopicState[];
  readonly sessions: readonly SessionState[];
  readonly conclusions: readonly ConclusionState[];
  readonly todos: readonly TodoState[];
  readonly memory: FoldMemory;
}

export interface TopicBookView {
  topics: TopicState[];
  sessions: SessionState[];
  conclusions: ConclusionState[];
  todos: TodoState[];
}

export interface ZoneQuery {
  now: string;
  activeLimit: number;
  historyDays: number;
  sessionUpdatedAt?: Readonly<Record<string, string>>;
}

export interface ZonedTopic extends TopicState {
  lastActive: string | null;
  zone: "active" | "history";
}

export interface ZonePartition {
  active: ZonedTopic[];
  history: ZonedTopic[];
}
