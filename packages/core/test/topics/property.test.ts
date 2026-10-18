import type { Event, EventOf, EventType } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import {
  applyEvents,
  canonicalTopicName,
  compareEvents,
  emptyTopicBook,
  foldEvents,
  resolveMergedTopic,
  topicBookView,
  type TopicBook,
  type TopicBookView,
} from "../../src/topics/index.js";
import { buildEvent, sessionKey } from "./helpers.js";

const ROUNDS = 200;
const BASE_SEED = 0x5eed;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    const left = copy[index];
    const right = copy[swap];
    if (left === undefined || right === undefined) continue;
    copy[index] = right;
    copy[swap] = left;
  }
  return copy;
}

function uniqueSorted(events: readonly Event[]): Event[] {
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

function view(book: TopicBook): TopicBookView {
  return topicBookView(book);
}

interface RoundMeta {
  parked: boolean;
  unassigned: boolean;
  key1: string;
  key2: string;
  key3: string;
}

function generate(round: number, rng: () => number): { events: Event[]; meta: RoundMeta } {
  const devices = ["dev-a", "dev-b", "dev-c"] as const;
  const seq = { "dev-a": 0, "dev-b": 0, "dev-c": 0 };
  let counter = round * 10000;
  let clock = Date.parse("2026-06-01T00:00:00.000Z") + round * 3_600_000;
  const events: Event[] = [];

  function nextTs(): string {
    clock += (1 + Math.floor(rng() * 5)) * 1000;
    return new Date(clock).toISOString();
  }

  function device(): (typeof devices)[number] {
    return devices[Math.floor(rng() * devices.length)] ?? "dev-a";
  }

  function emit<T extends EventType>(
    dev: (typeof devices)[number],
    ts: string,
    type: T,
    data: EventOf<T>["data"],
  ): EventOf<T> {
    seq[dev] += 1;
    counter += 1;
    const event = buildEvent({
      type,
      data,
      device: dev,
      ts,
      seq: seq[dev],
      counter,
    });
    events.push(event);
    return event;
  }

  const key1 = sessionKey(round * 10 + 1);
  const key2 = sessionKey(round * 10 + 2);
  const key3 = sessionKey(round * 10 + 3);
  const parked = rng() < 0.5;
  const unassigned = rng() < 0.5;

  const earlyTs = new Date(
    Date.parse("2026-05-01T00:00:00.000Z") + round * 3_600_000,
  ).toISOString();

  const sameTs = nextTs();
  emit("dev-a", sameTs, "topic.created", {
    topicId: "id-c",
    name: "You-Brain 设计",
    aliases: ["loser"],
  });
  emit("dev-b", sameTs, "topic.created", {
    topicId: "id-a",
    name: "you brain设计",
    aliases: ["winner"],
  });

  emit("dev-a", nextTs(), "topic.created", {
    topicId: "chain-a",
    name: `Chain A ${round}`,
    aliases: [],
  });
  emit("dev-b", nextTs(), "topic.created", {
    topicId: "chain-b",
    name: `Chain B ${round}`,
    aliases: [],
  });
  emit("dev-c", nextTs(), "topic.created", {
    topicId: "chain-c",
    name: `Chain C ${round}`,
    aliases: [],
  });

  emit("dev-a", nextTs(), "topic.status_changed", {
    topicId: "chain-b",
    status: "done",
    by: "user",
  });
  if (parked) {
    emit("dev-b", nextTs(), "topic.status_changed", {
      topicId: "chain-b",
      status: "parked",
      by: "user",
    });
  }
  emit("dev-c", nextTs(), "topic.status_changed", {
    topicId: "chain-b",
    status: "active",
    by: "auto",
  });

  emit("dev-a", nextTs(), "session.refined", {
    sessionKey: key1,
    fileId: `file-${round}-1a`,
    source: "claude-code",
    title: "first",
    summary: "s1",
    refinedUpTo: 2,
  });
  emit("dev-b", nextTs(), "session.refined", {
    sessionKey: key1,
    fileId: `file-${round}-1b`,
    source: "codex",
    title: "second",
    summary: "s2",
    refinedUpTo: 5,
  });
  emit(device(), nextTs(), "session.refined", {
    sessionKey: key1,
    fileId: `file-${round}-1c`,
    source: "cursor",
    title: "stale",
    summary: "nope",
    refinedUpTo: 3,
  });

  const tieTs = nextTs();
  emit("dev-a", tieTs, "session.refined", {
    sessionKey: key3,
    fileId: `file-${round}-3a`,
    source: "grok-build",
    title: "first-tie",
    summary: "tie-1",
    refinedUpTo: 4,
  });
  emit("dev-c", nextTs(), "session.refined", {
    sessionKey: key3,
    fileId: `file-${round}-3b`,
    source: "gemini-cli",
    title: "second-tie",
    summary: "tie-2",
    refinedUpTo: 4,
  });

  emit("dev-a", nextTs(), "topic.assigned", { topicId: "chain-a", sessionKey: key1 });
  emit("dev-b", nextTs(), "topic.assigned", { topicId: "chain-a", sessionKey: key2 });

  emit("dev-a", nextTs(), "todo.status_changed", {
    todoId: `todo-${round}`,
    status: "done",
    by: "auto",
  });
  emit("dev-b", nextTs(), "todo.status_changed", {
    todoId: `todo-${round}`,
    status: "open",
    by: "user",
  });
  emit("dev-c", nextTs(), "todo.added", {
    todoId: `todo-${round}`,
    topicId: "chain-a",
    text: "follow up",
    sessionKey: key1,
    confidence: 0.75,
  });
  emit("dev-a", nextTs(), "todo.status_changed", {
    todoId: `todo-${round}`,
    status: "dropped",
    by: "auto",
  });

  const conclusion = emit("dev-b", nextTs(), "conclusion.added", {
    conclusionId: `conclusion-${round}`,
    topicId: "chain-b",
    text: "shipped",
    sessionKey: key1,
  });
  events.push(conclusion);

  emit("dev-a", nextTs(), "topic.merged", { fromTopicId: "chain-a", intoTopicId: "chain-b" });
  emit("dev-b", nextTs(), "topic.merged", { fromTopicId: "chain-b", intoTopicId: "chain-c" });

  if (unassigned) {
    emit("dev-c", nextTs(), "topic.unassigned", { topicId: "chain-a", sessionKey: key2 });
  }

  emit("dev-a", nextTs(), "topic.renamed", {
    topicId: "chain-c",
    name: `Chain ${round} Final`,
    aliases: [`final-${round}`],
  });
  emit("dev-b", nextTs(), "topic.summary_rewritten", {
    topicId: "chain-a",
    summary: `sum-${round}`,
    nextStep: `step-${round}`,
  });

  emit(device(), nextTs(), "portrait.correction", {
    correctionId: `corr-${round}`,
    variant: "work",
    section: "style",
    text: "prefer short",
  });
  emit(device(), nextTs(), "reminder.issued", {
    reminderId: `issued-${round}`,
    kind: "follow_up",
    topicId: "chain-c",
    text: "ping",
  });
  emit(device(), nextTs(), "reminder.action", {
    reminderId: `action-${round}`,
    topicId: "chain-c",
    action: "ignore",
    until: null,
  });

  emit("dev-a", earlyTs, "topic.created", {
    topicId: `early-${round}`,
    name: `Early ${round}`,
    aliases: [],
  });

  return { events, meta: { parked, unassigned, key1, key2, key3 } };
}

function topic(book: TopicBook, topicId: string) {
  const found = book.topics.find((item) => item.topicId === topicId);
  if (!found) throw new Error(`missing topic ${topicId}`);
  return found;
}

function session(book: TopicBook, sessionKeyValue: string) {
  const found = book.sessions.find((item) => item.sessionKey === sessionKeyValue);
  if (!found) throw new Error(`missing session ${sessionKeyValue}`);
  return found;
}

function assertAcyclic(book: TopicBook): void {
  const byId = new Map(book.topics.map((item) => [item.topicId, item]));
  for (const item of book.topics) {
    const seen = new Set<string>();
    let current: string | null = item.topicId;
    while (current) {
      if (seen.has(current)) throw new Error(`cycle at ${item.topicId}`);
      seen.add(current);
      current = byId.get(current)?.mergedInto ?? null;
    }
  }
}

function assertPointers(book: TopicBook): void {
  const byId = new Map(book.topics.map((item) => [item.topicId, item]));
  const check = (topicId: string | null, label: string) => {
    if (!topicId) return;
    const target = byId.get(topicId);
    if (!target) throw new Error(`${label} points at missing ${topicId}`);
    if (target.mergedInto !== null) throw new Error(`${label} points at merged ${topicId}`);
  };
  for (const item of book.sessions) check(item.topicId, item.sessionKey);
  for (const item of book.conclusions) check(item.topicId, item.conclusionId);
  for (const item of book.todos) check(item.topicId, item.todoId);
}

function assertRefine(events: readonly Event[], book: TopicBook): void {
  const ordered = uniqueSorted(events);
  for (const item of book.sessions) {
    const refines = ordered.filter(
      (event): event is EventOf<"session.refined"> =>
        event.type === "session.refined" && event.data.sessionKey === item.sessionKey,
    );
    if (refines.length === 0) {
      expect(item.refinedUpTo).toBe(0);
      expect(item.source).toBe("");
      expect(item.title).toBe("");
      expect(item.summary).toBe("");
      expect(item.fileId).toBe("");
      continue;
    }
    const max = Math.max(...refines.map((event) => event.data.refinedUpTo));
    const winner = [...refines].reverse().find((event) => event.data.refinedUpTo === max);
    if (!winner) throw new Error(`missing refine winner for ${item.sessionKey}`);
    expect(item.refinedUpTo).toBe(winner.data.refinedUpTo);
    expect(item.source).toBe(winner.data.source);
    expect(item.title).toBe(winner.data.title);
    expect(item.summary).toBe(winner.data.summary);
    expect(item.fileId).toBe(winner.data.fileId);
  }
}

function assertSemantics(round: number, events: readonly Event[], book: TopicBook, meta: RoundMeta): void {
  const winner = topic(book, "id-a");
  const loser = topic(book, "id-c");
  expect(loser.mergedInto).toBe("id-a");
  expect(winner.mergedInto).toBeNull();
  expect(winner.name).toBe("you brain设计");
  expect(winner.aliases).toEqual(["winner"]);
  expect(resolveMergedTopic(book, "id-c")).toBe("id-a");

  expect(topic(book, "chain-a").mergedInto).toBe("chain-b");
  expect(topic(book, "chain-b").mergedInto).toBe("chain-c");
  expect(resolveMergedTopic(book, "chain-a")).toBe("chain-c");
  expect(resolveMergedTopic(book, "chain-b")).toBe("chain-c");

  const survivor = topic(book, "chain-c");
  expect(survivor.mergedInto).toBeNull();
  expect(survivor.name).toBe(`Chain ${round} Final`);
  expect(survivor.summary).toBe(`sum-${round}`);
  expect(survivor.nextStep).toBe(`step-${round}`);

  const mergedAway = topic(book, "chain-b");
  expect(mergedAway.userLocked).toBe(true);
  expect(mergedAway.statusBy).toBe("user");
  expect(mergedAway.status).toBe(meta.parked ? "parked" : "done");

  const first = session(book, meta.key1);
  expect(first.topicId).toBe("chain-c");
  expect(first.refinedUpTo).toBe(5);
  expect(first.title).toBe("second");
  expect(first.summary).toBe("s2");
  expect(first.fileId).toBe(`file-${round}-1b`);
  expect(first.source).toBe("codex");

  const second = session(book, meta.key2);
  expect(second.topicId).toBe(meta.unassigned ? null : "chain-c");

  const third = session(book, meta.key3);
  expect(third.title).toBe("second-tie");
  expect(third.summary).toBe("tie-2");
  expect(third.fileId).toBe(`file-${round}-3b`);
  expect(third.source).toBe("gemini-cli");
  expect(third.refinedUpTo).toBe(4);

  expect(book.conclusions.map((item) => item.topicId)).toEqual(["chain-c"]);
  const todo = book.todos.find((item) => item.todoId === `todo-${round}`);
  if (!todo) throw new Error("missing todo");
  expect(todo.topicId).toBe("chain-c");
  expect(todo.status).toBe("open");
  expect(todo.userLocked).toBe(true);
  expect(todo.statusBy).toBe("user");

  const liveNames = book.topics
    .filter((item) => item.mergedInto === null)
    .map((item) => canonicalTopicName(item.name));
  expect(new Set(liveNames).size).toBe(liveNames.length);
  assertAcyclic(book);
  assertPointers(book);
  assertRefine(events, book);
}

function assertStable(events: readonly Event[], rng: () => number): void {
  const full = foldEvents(events);
  const fullView = view(full);
  const shuffled = shuffle(events, rng);
  const duplicated = [...shuffled, ...shuffled];
  expect(view(foldEvents(shuffled))).toEqual(fullView);
  expect(view(foldEvents(duplicated))).toEqual(fullView);

  let book = emptyTopicBook();
  let rest = duplicated;
  while (rest.length > 0) {
    const size = 1 + Math.floor(rng() * 4);
    const chunk = rest.slice(0, size);
    rest = rest.slice(size);
    const before = view(book);
    const idsBefore = book.memory.ids.size;
    const logBefore = book.memory.log.length;
    const next = applyEvents(book, chunk);
    expect(view(book)).toEqual(before);
    expect(book.memory.ids.size).toBe(idsBefore);
    expect(book.memory.log.length).toBe(logBefore);
    book = next;
  }
  expect(view(book)).toEqual(fullView);
  expect(book.memory.log.map((event) => event.id)).toEqual(full.memory.log.map((event) => event.id));

  const ordered = uniqueSorted(events);
  const mid = Math.floor(ordered.length / 2);
  const prefix = foldEvents(ordered.slice(0, mid));
  const prefixView = view(prefix);
  const prefixIds = prefix.memory.ids.size;
  const appended = applyEvents(prefix, ordered.slice(mid));
  expect(view(prefix)).toEqual(prefixView);
  expect(prefix.memory.ids.size).toBe(prefixIds);
  expect(view(appended)).toEqual(fullView);
  expect(appended.memory.log.map((event) => event.id)).toEqual(
    full.memory.log.map((event) => event.id),
  );

  const held = ordered[mid];
  if (!held) throw new Error("missing held event");
  const partial = foldEvents(ordered.filter((_, index) => index !== mid));
  const partialView = view(partial);
  const partialIds = partial.memory.ids.size;
  const replayed = applyEvents(partial, [held]);
  expect(view(partial)).toEqual(partialView);
  expect(partial.memory.ids.size).toBe(partialIds);
  expect(replayed).not.toBe(partial);
  expect(view(replayed)).toEqual(fullView);
  expect(replayed.memory.log.map((event) => event.id)).toEqual(
    full.memory.log.map((event) => event.id),
  );

  expect(applyEvents(full, events)).toBe(full);
  expect(applyEvents(full, duplicated)).toBe(full);
}

describe("topic fold properties", () => {
  it("uses a deterministic unit-interval PRNG", () => {
    const left = mulberry32(1);
    const right = mulberry32(1);
    const first = left();
    expect(first).toBe(right());
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(left()).toBe(right());
  });

  it("matches full replay after shuffle, duplication, and incremental apply", () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const rng = mulberry32((BASE_SEED + round) >>> 0);
      try {
        const { events, meta } = generate(round, rng);
        const book = foldEvents(events);
        assertSemantics(round, events, book, meta);
        assertStable(events, rng);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`round ${round}: ${message}`, { cause: error });
      }
    }
  }, 60_000);
});
