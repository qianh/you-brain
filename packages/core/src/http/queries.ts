import type {
  ConclusionRecord,
  SessionRecord,
  SqliteStore,
  TodoRecord,
  TopicRecord,
} from "../store/index.js";
import type { DeviceRecord } from "@you-brain/protocol";

import { presentReminder, presentReminders } from "../reminders/present.js";
import type { ReminderTopicName } from "../reminders/present.js";
import type {
  ConclusionView,
  ReminderView,
  RemindersResponse,
  TodayResponse,
  TodaySession,
  TodoView,
  TopicDetail,
  TopicListItem,
  TopicSessionLink,
  TopicsQuery,
  TopicsResponse,
  ZoneSettings,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function formatZonedDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

interface ZonedTopic extends TopicRecord {
  zone: "active" | "history";
}

/** Active/history split from the stored `lastActive` column. Matches 技术方案 6.5. */
export function partitionTopicRecords(
  topics: readonly TopicRecord[],
  query: { now: string; activeLimit: number; historyDays: number },
): { active: ZonedTopic[]; history: ZonedTopic[] } {
  const nowMs = Date.parse(query.now);
  if (Number.isNaN(nowMs)) {
    throw new Error("now must be an ISO-8601 timestamp");
  }
  const limit = Number.isFinite(query.activeLimit)
    ? Math.max(0, Math.floor(query.activeLimit))
    : 0;
  const windowMs = query.historyDays * DAY_MS;
  const visible = topics.filter((topic) => topic.mergedInto === null);
  const candidates = visible
    .flatMap((topic) => {
      if (topic.status === "done" || topic.lastActive === null) return [];
      const ms = Date.parse(topic.lastActive);
      if (Number.isNaN(ms) || nowMs - ms >= windowMs) return [];
      return [{ topic, ms }];
    })
    .sort((left, right) => {
      if (left.ms !== right.ms) return right.ms - left.ms;
      return compareText(left.topic.topicId, right.topic.topicId);
    });
  const active = candidates.slice(0, limit).map((candidate) =>
    decorate(candidate.topic, "active"),
  );
  const activeIds = new Set(active.map((topic) => topic.topicId));
  const history = visible
    .filter((topic) => !activeIds.has(topic.topicId))
    .map((topic) => decorate(topic, "history"))
    .sort((left, right) => {
      const leftMs = stamp(left.lastActive);
      const rightMs = stamp(right.lastActive);
      if (leftMs === null && rightMs === null) {
        return compareText(left.topicId, right.topicId);
      }
      if (leftMs === null) return 1;
      if (rightMs === null) return -1;
      if (leftMs !== rightMs) return rightMs - leftMs;
      return compareText(left.topicId, right.topicId);
    });
  return { active, history };
}

function decorate(topic: TopicRecord, zone: ZonedTopic["zone"]): ZonedTopic {
  return { ...topic, aliases: [...topic.aliases], zone };
}

function stamp(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function conclusionView(record: ConclusionRecord): ConclusionView {
  return {
    conclusionId: record.conclusionId,
    topicId: record.topicId,
    sessionKey: record.sessionKey,
    text: record.text,
    ts: record.ts,
  };
}

function todoView(record: TodoRecord): TodoView {
  return {
    todoId: record.todoId,
    topicId: record.topicId,
    sessionKey: record.sessionKey,
    text: record.text,
    status: record.status,
    statusBy: record.statusBy,
    confidence: record.confidence,
    ts: record.ts,
    userLocked: record.userLocked,
  };
}

function sessionLink(record: SessionRecord): TopicSessionLink {
  return {
    sessionKey: record.sessionKey,
    source: record.source,
    device: record.device,
    fileId: record.fileId,
    title: record.title,
    summary: record.summary,
    updatedAt: record.updatedAt,
  };
}

interface Snapshot {
  now: Date;
  topics: TopicRecord[];
  conclusions: ConclusionRecord[];
  todos: TodoRecord[];
  sessions: Map<string, SessionRecord>;
  today: SessionRecord[];
  zones: { active: ZonedTopic[]; history: ZonedTopic[] };
}

function readSnapshot(store: SqliteStore, settings: ZoneSettings): Snapshot {
  const now = settings.now?.() ?? new Date();
  const topics = store.listTopics();
  const conclusions = store.listConclusions();
  const todos = store.listTodos();
  const sessions = new Map<string, SessionRecord>();
  const add = (record: SessionRecord): void => {
    sessions.set(record.sessionKey, record);
  };
  const remember = (sessionKey: string): void => {
    if (sessions.has(sessionKey)) return;
    const record = store.getSession(sessionKey);
    if (record) add(record);
  };
  const today = store.listTodaySessions({
    timeZone: settings.timeZone,
    now,
  });
  for (const session of today) add(session);
  for (const conclusion of conclusions) remember(conclusion.sessionKey);
  for (const todo of todos) remember(todo.sessionKey);
  for (const event of store.listEvents()) {
    if ("sessionKey" in event.data && typeof event.data.sessionKey === "string") {
      remember(event.data.sessionKey);
    }
  }
  // Sessions that exist only as rows (uploaded, not yet referenced by an event)
  // still belong on topic detail and in the active zone.
  for (const session of store.listSessions()) add(session);
  return {
    now,
    topics,
    conclusions,
    todos,
    sessions,
    today,
    zones: partitionTopicRecords(topics, {
      now: now.toISOString(),
      activeLimit: settings.activeLimit,
      historyDays: settings.historyDays,
    }),
  };
}

function listItem(topic: ZonedTopic, todos: readonly TodoRecord[]): TopicListItem {
  return {
    topicId: topic.topicId,
    name: topic.name,
    aliases: [...topic.aliases],
    status: topic.status,
    statusBy: topic.statusBy,
    summary: topic.summary,
    nextStep: topic.nextStep,
    lastActive: topic.lastActive,
    zone: topic.zone,
    createdTs: topic.createdTs,
    lastUserOpAt: topic.lastUserOpAt,
    userLocked: topic.userLocked,
    openTodoCount: todos.filter(
      (todo) => todo.topicId === topic.topicId && todo.status === "open",
    ).length,
  };
}

function zoneOf(snapshot: Snapshot, topicId: string): "active" | "history" {
  if (snapshot.zones.active.some((topic) => topic.topicId === topicId)) {
    return "active";
  }
  return "history";
}

export interface StoreReaders {
  today(): Promise<TodayResponse>;
  topics(query: TopicsQuery): Promise<TopicsResponse>;
  topic(id: string): Promise<TopicDetail | null>;
  todo(todoId: string): Promise<TodoView | null>;
  devices(): Promise<DeviceRecord[]>;
  reminders(all: boolean): Promise<RemindersResponse>;
  reminder(id: string): Promise<ReminderView | null>;
}

export function createStoreReaders(
  store: SqliteStore,
  settings: ZoneSettings,
): StoreReaders {
  return {
    async today() {
      const snapshot = readSnapshot(store, settings);
      const names = new Map(
        snapshot.topics.map((topic) => [topic.topicId, topic.name]),
      );
      const sessions: TodaySession[] = snapshot.today.map((session) => ({
          sessionKey: session.sessionKey,
          source: session.source,
          device: session.device,
          fileId: session.fileId,
          title: session.title,
          summary: session.summary,
          startedAt: session.startedAt,
          updatedAt: session.updatedAt,
          msgCount: session.msgCount,
          refinedUpTo: session.refinedUpTo,
          topicId: session.topicId,
          topicName:
            session.topicId === null
              ? null
              : (names.get(session.topicId) ?? null),
          conclusions: snapshot.conclusions
            .filter((item) => item.sessionKey === session.sessionKey)
            .map(conclusionView),
          todos: snapshot.todos
            .filter((item) => item.sessionKey === session.sessionKey)
            .map(todoView),
        }));
      return {
        date: formatZonedDate(snapshot.now, settings.timeZone),
        timeZone: settings.timeZone,
        sessions,
      };
    },
    async topics(query) {
      const snapshot = readSnapshot(store, settings);
      const rows = [
        ...(query.zone === "history" ? [] : snapshot.zones.active),
        ...(query.zone === "active" ? [] : snapshot.zones.history),
      ];
      const topics = rows
        .filter((topic) => query.status === undefined || topic.status === query.status)
        .map((topic) => listItem(topic, snapshot.todos));
      return { topics };
    },
    async topic(id) {
      const snapshot = readSnapshot(store, settings);
      const topic = snapshot.topics.find((item) => item.topicId === id);
      if (!topic) return null;
      const sessions = [...snapshot.sessions.values()]
        .filter((session) => session.topicId === id)
        .map(sessionLink)
        .sort((left, right) => {
          const leftMs = stamp(left.updatedAt);
          const rightMs = stamp(right.updatedAt);
          if (leftMs === null && rightMs === null) {
            return compareText(left.sessionKey, right.sessionKey);
          }
          if (leftMs === null) return 1;
          if (rightMs === null) return -1;
          if (leftMs !== rightMs) return rightMs - leftMs;
          return compareText(left.sessionKey, right.sessionKey);
        });
      const detail: TopicDetail = {
        topicId: topic.topicId,
        name: topic.name,
        aliases: [...topic.aliases],
        status: topic.status,
        statusBy: topic.statusBy,
        summary: topic.summary,
        nextStep: topic.nextStep,
        lastActive: topic.lastActive,
        zone: zoneOf(snapshot, topic.topicId),
        mergedInto: topic.mergedInto,
        createdTs: topic.createdTs,
        lastUserOpAt: topic.lastUserOpAt,
        userLocked: topic.userLocked,
        conclusions: snapshot.conclusions
          .filter((item) => item.topicId === id)
          .map(conclusionView),
        todos: snapshot.todos.filter((item) => item.topicId === id).map(todoView),
        sessions,
      };
      return detail;
    },
    async todo(todoId) {
      const record = store.listTodos().find((item) => item.todoId === todoId);
      return record ? todoView(record) : null;
    },
    async devices() {
      return store.listDevices();
    },
    async reminders(all) {
      return {
        reminders: presentReminders(
          store.listReminders(),
          readerNow(settings),
          reminderTopics(store),
          all,
        ),
      };
    },
    async reminder(id) {
      const record = store.listReminders().find((item) => item.reminderId === id);
      if (!record) return null;
      return presentReminder(record, readerNow(settings), reminderTopics(store));
    },
  };
}

function readerNow(settings: ZoneSettings): string {
  return (settings.now?.() ?? new Date()).toISOString();
}

function reminderTopics(store: SqliteStore): ReminderTopicName[] {
  return store.listTopics().map((topic) => ({
    topicId: topic.topicId,
    name: topic.name,
    mergedInto: topic.mergedInto,
  }));
}
