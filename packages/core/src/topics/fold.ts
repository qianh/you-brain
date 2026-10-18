import type { Event, EventOf } from "@you-brain/protocol";

import { canonicalTopicName } from "./normalize.js";
import { compareEvents, compareSortKeys, compareText, eventSortKey } from "./order.js";
import type {
  ConclusionState,
  FoldMemory,
  SessionState,
  TodoMemory,
  TopicBook,
  TopicBookView,
  TopicState,
} from "./types.js";

function blankTopic(topicId: string): TopicState {
  return {
    topicId,
    name: "",
    aliases: [],
    status: "active",
    statusBy: "auto",
    summary: "",
    nextStep: "",
    mergedInto: null,
    createdTs: null,
    lastUserOpAt: null,
    userLocked: false,
  };
}

function blankSession(sessionKey: string): SessionState {
  return {
    sessionKey,
    source: "",
    fileId: "",
    title: "",
    summary: "",
    refinedUpTo: 0,
    topicId: null,
  };
}

function blankTodo(todoId: string): TodoMemory {
  return {
    todoId,
    topicId: "",
    sessionKey: "",
    text: "",
    status: "open",
    statusBy: "auto",
    confidence: 0,
    ts: "",
    userLocked: false,
    userStatusTs: null,
  };
}

function emptyMemory(): FoldMemory {
  return {
    topics: new Map(),
    sessions: new Map(),
    conclusions: new Map(),
    todos: new Map(),
    parent: new Map(),
    liveByName: new Map(),
    ids: new Set(),
    log: [],
    last: null,
  };
}

function resolveTopicId(memory: FoldMemory, id: string): string {
  let current = id;
  const seen = new Set<string>();
  while (true) {
    const parent = memory.parent.get(current);
    if (parent === undefined || parent === current || seen.has(current)) return current;
    seen.add(current);
    current = parent;
  }
}

function ensureRow(memory: FoldMemory, id: string): TopicState {
  const existing = memory.topics.get(id);
  if (existing) return existing;
  const topic = blankTopic(id);
  const parent = memory.parent.get(id);
  if (parent !== undefined) topic.mergedInto = parent;
  memory.topics.set(id, topic);
  return topic;
}

function ensureLive(memory: FoldMemory, id: string): TopicState {
  return ensureRow(memory, resolveTopicId(memory, id));
}

function touchUser(topic: TopicState, ts: string): void {
  const next = Date.parse(ts);
  if (Number.isNaN(next)) return;
  if (topic.lastUserOpAt === null || next >= Date.parse(topic.lastUserOpAt)) {
    topic.lastUserOpAt = ts;
  }
}

function releaseName(memory: FoldMemory, topicId: string): void {
  for (const [key, id] of [...memory.liveByName.entries()]) {
    if (id === topicId) memory.liveByName.delete(key);
  }
}

function link(memory: FoldMemory, fromId: string, intoId: string): void {
  const from = resolveTopicId(memory, fromId);
  const into = resolveTopicId(memory, intoId);
  if (from === into) return;
  const loser = memory.topics.get(from);
  memory.parent.set(from, into);
  const fromTopic = ensureRow(memory, from);
  fromTopic.mergedInto = into;
  const winner = ensureRow(memory, into);
  if (loser?.lastUserOpAt) touchUser(winner, loser.lastUserOpAt);
  for (const session of memory.sessions.values()) {
    if (session.topicId === from) session.topicId = into;
  }
  for (const conclusion of memory.conclusions.values()) {
    if (conclusion.topicId === from) conclusion.topicId = into;
  }
  for (const todo of memory.todos.values()) {
    if (todo.topicId === from) todo.topicId = into;
  }
  releaseName(memory, from);
}

function compareCreated(left: TopicState, right: TopicState): number {
  const leftMs = Date.parse(left.createdTs ?? "");
  const rightMs = Date.parse(right.createdTs ?? "");
  if (leftMs !== rightMs) return leftMs < rightMs ? -1 : 1;
  return compareText(left.topicId, right.topicId);
}

function considerSameName(memory: FoldMemory, topic: TopicState): void {
  if (topic.createdTs === null) return;
  if (resolveTopicId(memory, topic.topicId) !== topic.topicId) return;
  releaseName(memory, topic.topicId);
  const key = canonicalTopicName(topic.name);
  const ownerId = memory.liveByName.get(key);
  if (ownerId === undefined || ownerId === topic.topicId) {
    memory.liveByName.set(key, topic.topicId);
    return;
  }
  const owner = memory.topics.get(ownerId);
  if (
    !owner ||
    owner.createdTs === null ||
    resolveTopicId(memory, owner.topicId) !== owner.topicId
  ) {
    memory.liveByName.set(key, topic.topicId);
    return;
  }
  if (compareCreated(topic, owner) < 0) {
    link(memory, owner.topicId, topic.topicId);
    memory.liveByName.set(key, topic.topicId);
    return;
  }
  link(memory, topic.topicId, owner.topicId);
  memory.liveByName.set(key, owner.topicId);
}

function indexName(memory: FoldMemory, topic: TopicState): void {
  if (resolveTopicId(memory, topic.topicId) !== topic.topicId) return;
  releaseName(memory, topic.topicId);
  const key = canonicalTopicName(topic.name);
  if (!memory.liveByName.has(key)) memory.liveByName.set(key, topic.topicId);
}

function applyCreated(memory: FoldMemory, event: EventOf<"topic.created">): void {
  const topic = ensureRow(memory, event.data.topicId);
  topic.name = event.data.name;
  topic.aliases = [...event.data.aliases];
  if (topic.createdTs === null) topic.createdTs = event.ts;
  considerSameName(memory, topic);
}

function applyRenamed(memory: FoldMemory, event: EventOf<"topic.renamed">): void {
  const topic = ensureLive(memory, event.data.topicId);
  topic.name = event.data.name;
  topic.aliases = [...event.data.aliases];
  indexName(memory, topic);
  touchUser(topic, event.ts);
}

function applyAssigned(memory: FoldMemory, event: EventOf<"topic.assigned">): void {
  const topicId = resolveTopicId(memory, event.data.topicId);
  ensureRow(memory, topicId);
  let session = memory.sessions.get(event.data.sessionKey);
  if (!session) {
    session = blankSession(event.data.sessionKey);
    memory.sessions.set(session.sessionKey, session);
  }
  session.topicId = topicId;
}

function applyUnassigned(memory: FoldMemory, event: EventOf<"topic.unassigned">): void {
  const topicId = resolveTopicId(memory, event.data.topicId);
  const topic = ensureRow(memory, topicId);
  touchUser(topic, event.ts);
  const session = memory.sessions.get(event.data.sessionKey);
  if (session && session.topicId === topicId) session.topicId = null;
}

function applyTopicStatus(
  memory: FoldMemory,
  event: EventOf<"topic.status_changed">,
): void {
  const topic = ensureLive(memory, event.data.topicId);
  if (event.data.by === "auto" && topic.userLocked) return;
  topic.status = event.data.status;
  topic.statusBy = event.data.by;
  if (event.data.by === "user") {
    topic.userLocked = true;
    touchUser(topic, event.ts);
  }
}

function applySummary(
  memory: FoldMemory,
  event: EventOf<"topic.summary_rewritten">,
): void {
  const topic = ensureLive(memory, event.data.topicId);
  topic.summary = event.data.summary;
  topic.nextStep = event.data.nextStep;
}

function applyMerged(memory: FoldMemory, event: EventOf<"topic.merged">): void {
  ensureRow(memory, event.data.fromTopicId);
  ensureRow(memory, event.data.intoTopicId);
  const from = resolveTopicId(memory, event.data.fromTopicId);
  const into = resolveTopicId(memory, event.data.intoTopicId);
  if (from === into) return;
  link(memory, from, into);
  const survivor = memory.topics.get(resolveTopicId(memory, into));
  if (survivor) touchUser(survivor, event.ts);
}

function applyRefined(memory: FoldMemory, event: EventOf<"session.refined">): void {
  let session = memory.sessions.get(event.data.sessionKey);
  if (!session) {
    session = blankSession(event.data.sessionKey);
    memory.sessions.set(session.sessionKey, session);
  }
  if (event.data.refinedUpTo < session.refinedUpTo) return;
  session.source = event.data.source;
  session.fileId = event.data.fileId;
  session.title = event.data.title;
  session.summary = event.data.summary;
  session.refinedUpTo = event.data.refinedUpTo;
}

function applyConclusion(memory: FoldMemory, event: EventOf<"conclusion.added">): void {
  const topicId = resolveTopicId(memory, event.data.topicId);
  ensureRow(memory, topicId);
  const conclusion: ConclusionState = {
    conclusionId: event.data.conclusionId,
    topicId,
    sessionKey: event.data.sessionKey,
    text: event.data.text,
    ts: event.ts,
  };
  memory.conclusions.set(conclusion.conclusionId, conclusion);
}

function touchTodoTopic(memory: FoldMemory, todo: TodoMemory): void {
  if (!todo.userLocked || todo.userStatusTs === null || todo.topicId === "") return;
  const topic = ensureRow(memory, resolveTopicId(memory, todo.topicId));
  touchUser(topic, todo.userStatusTs);
}

function applyTodoAdded(memory: FoldMemory, event: EventOf<"todo.added">): void {
  const topicId = resolveTopicId(memory, event.data.topicId);
  ensureRow(memory, topicId);
  const existing = memory.todos.get(event.data.todoId);
  if (!existing) {
    memory.todos.set(event.data.todoId, {
      todoId: event.data.todoId,
      topicId,
      sessionKey: event.data.sessionKey,
      text: event.data.text,
      status: "open",
      statusBy: "auto",
      confidence: event.data.confidence,
      ts: event.ts,
      userLocked: false,
      userStatusTs: null,
    });
    return;
  }
  existing.topicId = topicId;
  existing.sessionKey = event.data.sessionKey;
  existing.text = event.data.text;
  existing.confidence = event.data.confidence;
  existing.ts = event.ts;
  touchTodoTopic(memory, existing);
}

function applyTodoStatus(
  memory: FoldMemory,
  event: EventOf<"todo.status_changed">,
): void {
  let todo = memory.todos.get(event.data.todoId);
  if (!todo) {
    todo = blankTodo(event.data.todoId);
    memory.todos.set(todo.todoId, todo);
  }
  if (event.data.by === "auto" && todo.userLocked) return;
  todo.status = event.data.status;
  todo.statusBy = event.data.by;
  if (event.data.by === "user") {
    todo.userLocked = true;
    todo.userStatusTs = event.ts;
    touchTodoTopic(memory, todo);
  }
}

function applyReminderAction(
  memory: FoldMemory,
  event: EventOf<"reminder.action">,
): void {
  const topic = ensureRow(memory, resolveTopicId(memory, event.data.topicId));
  touchUser(topic, event.ts);
}

function applyOne(memory: FoldMemory, event: Event): void {
  switch (event.type) {
    case "session.refined":
      applyRefined(memory, event);
      break;
    case "topic.created":
      applyCreated(memory, event);
      break;
    case "topic.assigned":
      applyAssigned(memory, event);
      break;
    case "topic.unassigned":
      applyUnassigned(memory, event);
      break;
    case "topic.renamed":
      applyRenamed(memory, event);
      break;
    case "topic.status_changed":
      applyTopicStatus(memory, event);
      break;
    case "topic.merged":
      applyMerged(memory, event);
      break;
    case "topic.summary_rewritten":
      applySummary(memory, event);
      break;
    case "conclusion.added":
      applyConclusion(memory, event);
      break;
    case "todo.added":
      applyTodoAdded(memory, event);
      break;
    case "todo.status_changed":
      applyTodoStatus(memory, event);
      break;
    case "reminder.action":
      applyReminderAction(memory, event);
      break;
    case "portrait.correction":
    case "portrait.correction_applied":
    case "reminder.issued":
      break;
    default: {
      const unreachable: never = event;
      throw new Error(`Unsupported event ${String(unreachable)}`);
    }
  }
  memory.ids.add(event.id);
  memory.log.push(event);
  const key = eventSortKey(event);
  if (memory.last === null || compareSortKeys(key, memory.last) > 0) {
    memory.last = key;
  }
}

function orderedUnique(events: readonly Event[]): Event[] {
  const sorted = [...events].sort(compareEvents);
  const seen = new Set<string>();
  const unique: Event[] = [];
  for (const event of sorted) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  return unique;
}

function copyTopic(topic: TopicState): TopicState {
  return { ...topic, aliases: [...topic.aliases] };
}

function toPublicTodo(todo: TodoMemory): TopicBook["todos"][number] {
  return {
    todoId: todo.todoId,
    topicId: todo.topicId,
    sessionKey: todo.sessionKey,
    text: todo.text,
    status: todo.status,
    statusBy: todo.statusBy,
    confidence: todo.confidence,
    ts: todo.ts,
    userLocked: todo.userLocked,
  };
}

function materialize(memory: FoldMemory): TopicBook {
  return {
    topics: [...memory.topics.values()]
      .map(copyTopic)
      .sort((left, right) => compareText(left.topicId, right.topicId)),
    sessions: [...memory.sessions.values()]
      .map((session) => ({ ...session }))
      .sort((left, right) => compareText(left.sessionKey, right.sessionKey)),
    conclusions: [...memory.conclusions.values()]
      .map((conclusion) => ({ ...conclusion }))
      .sort((left, right) => compareText(left.conclusionId, right.conclusionId)),
    todos: [...memory.todos.values()]
      .map(toPublicTodo)
      .sort((left, right) => compareText(left.todoId, right.todoId)),
    memory,
  };
}

function cloneMemory(memory: FoldMemory): FoldMemory {
  return {
    topics: new Map(
      [...memory.topics].map(([id, topic]) => [id, { ...topic, aliases: [...topic.aliases] }]),
    ),
    sessions: new Map([...memory.sessions].map(([id, session]) => [id, { ...session }])),
    conclusions: new Map(
      [...memory.conclusions].map(([id, conclusion]) => [id, { ...conclusion }]),
    ),
    todos: new Map([...memory.todos].map(([id, todo]) => [id, { ...todo }])),
    parent: new Map(memory.parent),
    liveByName: new Map(memory.liveByName),
    ids: new Set(memory.ids),
    log: memory.log.slice(),
    last: memory.last ? { ...memory.last } : null,
  };
}

export function foldEvents(events: readonly Event[]): TopicBook {
  const memory = emptyMemory();
  for (const event of orderedUnique(events)) applyOne(memory, event);
  return materialize(memory);
}

export function emptyTopicBook(): TopicBook {
  return materialize(emptyMemory());
}

export function applyEvents(book: TopicBook, events: readonly Event[]): TopicBook {
  const seen = new Set<string>();
  const fresh: Event[] = [];
  for (const event of events) {
    if (book.memory.ids.has(event.id) || seen.has(event.id)) continue;
    seen.add(event.id);
    fresh.push(event);
  }
  if (fresh.length === 0) return book;
  const last = book.memory.last;
  if (last && fresh.some((event) => compareSortKeys(eventSortKey(event), last) < 0)) {
    return foldEvents([...book.memory.log, ...fresh]);
  }
  const memory = cloneMemory(book.memory);
  for (const event of orderedUnique(fresh)) applyOne(memory, event);
  return materialize(memory);
}

export function topicBookView(book: TopicBook): TopicBookView {
  return {
    topics: book.topics.map(copyTopic),
    sessions: book.sessions.map((session) => ({ ...session })),
    conclusions: book.conclusions.map((conclusion) => ({ ...conclusion })),
    todos: book.todos.map((todo) => ({ ...todo })),
  };
}
