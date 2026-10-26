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
  store.replaceDerived({
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
  });
}
