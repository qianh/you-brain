import { foldReminders } from "../reminders/fold.js";
import type { TopicBookPersistence } from "../store/types.js";
import type { TopicBook } from "./types.js";
import { deriveLastActive } from "./zones.js";

export function persistTopicBook(store: TopicBookPersistence, book: TopicBook): void {
  const sessionUpdatedAt: Record<string, string> = {};
  for (const session of book.sessions) {
    const stored = store.getSession(session.sessionKey);
    if (stored?.updatedAt) sessionUpdatedAt[session.sessionKey] = stored.updatedAt;
  }
  const lastActive = deriveLastActive(book, sessionUpdatedAt);
  const snapshot = {
    topics: book.topics.map((topic) => ({
      topicId: topic.topicId,
      name: topic.name,
      aliases: [...topic.aliases],
      status: topic.status,
      statusBy: topic.statusBy,
      summary: topic.summary,
      nextStep: topic.nextStep,
      lastActive: lastActive.get(topic.topicId) ?? null,
      mergedInto: topic.mergedInto,
      createdTs: topic.createdTs,
      lastUserOpAt: topic.lastUserOpAt,
      lastContentAt: topic.lastContentAt,
      userLocked: topic.userLocked,
    })),
    sessions: book.sessions.map((session) => ({
      sessionKey: session.sessionKey,
      source: session.source,
      fileId: session.fileId === "" ? null : session.fileId,
      title: session.title,
      summary: session.summary,
      refinedUpTo: session.refinedUpTo,
      refinedAt: session.refinedAt,
      topicId: session.topicId,
    })),
    conclusions: book.conclusions.map((conclusion) => ({ ...conclusion })),
    todos: book.todos.map((todo) => ({ ...todo })),
    events: book.memory.log,
    reminders: foldReminders(book.memory.log),
  };
  const next: Persisted = {
    generation: 0,
    topics: signatures(snapshot.topics, (topic) => topic.topicId),
    conclusions: signatures(snapshot.conclusions, (conclusion) => conclusion.conclusionId),
    todos: signatures(snapshot.todos, (todo) => todo.todoId),
    sessionKeys: new Set(snapshot.sessions.map((session) => session.sessionKey)),
    eventIds: new Set(snapshot.events.map((event) => event.id)),
  };
  const previous = persisted.get(store);
  if (previous !== undefined && store.applyDerivedChanges) {
    const generation = store.applyDerivedChanges({
      basedOn: previous.generation,
      events: snapshot.events.filter((event) => !previous.eventIds.has(event.id)),
      topics: changed(snapshot.topics, (topic) => topic.topicId, previous.topics, next.topics),
      conclusions: changed(snapshot.conclusions, (c) => c.conclusionId, previous.conclusions, next.conclusions),
      todos: changed(snapshot.todos, (todo) => todo.todoId, previous.todos, next.todos),
      // Capture also writes title, summary and topic on session rows; the full rewrite set
      // them back from the book every time, so every session is still written.
      sessions: snapshot.sessions,
      removedTopics: removed(previous.topics, next.topics),
      removedConclusions: removed(previous.conclusions, next.conclusions),
      removedTodos: removed(previous.todos, next.todos),
      detachedSessions: [...previous.sessionKeys].filter((key) => !next.sessionKeys.has(key)),
      reminders: snapshot.reminders,
    });
    if (generation !== null) {
      persisted.set(store, { ...next, generation });
      return;
    }
  }
  store.replaceDerived(snapshot);
  if (store.derivedGeneration) persisted.set(store, { ...next, generation: store.derivedGeneration() });
}

/**
 * What this process last wrote to the derived tables, per store. Rewriting all of them
 * (a thousand topics, nine thousand conclusions, every event re-inserted) on each topic event
 * held the daemon's thread for hundreds of milliseconds, seconds under load; now only rows
 * that differ are written. The generation guards against writes from elsewhere: if the
 * tables moved on, the store refuses the diff and the book is rewritten in full.
 */
interface Persisted {
  generation: number;
  topics: Map<string, string>;
  conclusions: Map<string, string>;
  todos: Map<string, string>;
  sessionKeys: Set<string>;
  eventIds: Set<string>;
}

const persisted = new WeakMap<TopicBookPersistence, Persisted>();

function signatures<T>(rows: readonly T[], key: (row: T) => string): Map<string, string> {
  return new Map(rows.map((row) => [key(row), JSON.stringify(row)]));
}

function changed<T>(
  rows: readonly T[],
  key: (row: T) => string,
  before: Map<string, string>,
  after: Map<string, string>,
): T[] {
  return rows.filter((row) => before.get(key(row)) !== after.get(key(row)));
}

function removed(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...before.keys()].filter((id) => !after.has(id));
}
