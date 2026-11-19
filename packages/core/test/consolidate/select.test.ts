import type { Event } from "@you-brain/protocol";
import { describe, expect, it } from "bun:test";

import { instantOnLocalDay } from "../../src/consolidate/schedule.js";
import {
  RECENT_SESSIONS,
  recentTopicSessions,
  selectChangedTopics,
  selectMergeCandidates,
  selectTopicsChangedOnDay,
} from "../../src/consolidate/select.js";
import type { SessionState, TopicBook, ZonedTopic } from "../../src/topics/types.js";
import { createMergedTopicResolver, partitionTopics } from "../../src/topics/zones.js";
import {
  DAY_BEFORE,
  DAY_OF,
  LATER,
  LOCAL_DAY,
  PITCAIRN,
  SHANGHAI,
  assigned,
  created,
  ev,
  fold,
  key,
  refined,
} from "./fixture.js";

function changed(events: Parameters<typeof fold>[0], patch: {
  day?: string;
  timeZone?: string;
  sessionUpdatedAt?: Record<string, string>;
  activeLimit?: number;
  now?: string;
} = {}) {
  return selectChangedTopics({
    book: fold(events),
    sessionUpdatedAt: patch.sessionUpdatedAt ?? {},
    day: patch.day ?? LOCAL_DAY,
    timeZone: patch.timeZone ?? SHANGHAI,
    now: patch.now ?? LATER,
    activeLimit: patch.activeLimit ?? 10,
    historyDays: 30,
  }).map((item) => item.topic.topicId);
}

describe("selectChangedTopics", () => {
  it("selects a topic whose session was updated on that local day", () => {
    const session = key(1);
    const events = [
      created("alpha", "甲", DAY_BEFORE),
      refined(session, "标题", "概要", DAY_BEFORE),
      assigned("alpha", session, DAY_BEFORE),
    ];
    expect(changed(events, { sessionUpdatedAt: { [session]: DAY_OF } })).toEqual(["alpha"]);
    expect(changed(events, { sessionUpdatedAt: { [session]: DAY_BEFORE } })).toEqual([]);
  });

  it("selects a new conclusion or refine, and ignores renames and todo status", () => {
    const session = key(2);
    const base = [
      created("alpha", "甲", DAY_BEFORE),
      refined(session, "标题", "概要", DAY_BEFORE),
      assigned("alpha", session, DAY_BEFORE),
    ];
    expect(
      changed([
        ...base,
        ev(
          "conclusion.added",
          { conclusionId: "c1", topicId: "alpha", text: "新结论", sessionKey: session },
          DAY_OF,
        ),
      ]),
    ).toEqual(["alpha"]);
    expect(
      changed([
        ...base,
        ev(
          "session.refined",
          {
            sessionKey: session,
            fileId: "file-1",
            source: "claude-code",
            title: "更新",
            summary: "更新了",
            refinedUpTo: 2,
          },
          DAY_OF,
        ),
      ]),
    ).toEqual(["alpha"]);
    expect(
      changed([
        ...base,
        ev("todo.added", {
          todoId: "todo-1",
          topicId: "alpha",
          text: "去做",
          sessionKey: session,
          confidence: 0.9,
        }, DAY_BEFORE),
        ev("todo.status_changed", { todoId: "todo-1", status: "done", by: "user" }, DAY_OF),
      ]),
    ).toEqual([]);
    expect(
      changed([
        ...base,
        ev("topic.renamed", { topicId: "alpha", name: "甲二", aliases: ["别名"] }, DAY_OF),
      ]),
    ).toEqual([]);
    expect(
      changed([
        ...base,
        ev(
          "topic.summary_rewritten",
          { topicId: "alpha", summary: "已经写过", nextStep: "" },
          DAY_OF,
        ),
      ]),
    ).toEqual([]);
  });

  it("skips a topic whose latest rewrite is newer than the day's last change", () => {
    const session = key(3);
    const events = [
      created("alpha", "甲", DAY_BEFORE),
      refined(session, "标题", "概要", DAY_BEFORE),
      assigned("alpha", session, DAY_BEFORE),
      ev(
        "conclusion.added",
        { conclusionId: "c1", topicId: "alpha", text: "新结论", sessionKey: session },
        DAY_OF,
      ),
      ev(
        "topic.summary_rewritten",
        { topicId: "alpha", summary: "当晚重写", nextStep: "" },
        LATER,
      ),
    ];
    expect(changed(events)).toEqual([]);
    expect(
      selectTopicsChangedOnDay({
        book: fold(events),
        sessionUpdatedAt: {},
        day: LOCAL_DAY,
        timeZone: SHANGHAI,
        now: LATER,
        activeLimit: 10,
        historyDays: 30,
      }).map((item) => item.topic.topicId),
    ).toEqual(["alpha"]);
    const earlierRewrite = [
      created("alpha", "甲", DAY_BEFORE),
      ev(
        "topic.summary_rewritten",
        { topicId: "alpha", summary: "早上的概要", nextStep: "" },
        "2026-10-23T00:30:00.000Z",
      ),
      refined(session, "标题", "概要", DAY_BEFORE),
      assigned("alpha", session, DAY_BEFORE),
      ev(
        "conclusion.added",
        { conclusionId: "c1", topicId: "alpha", text: "新结论", sessionKey: session },
        DAY_OF,
      ),
    ];
    expect(changed(earlierRewrite)).toEqual(["alpha"]);
  });

  it("skips a user-locked topic and a topic that has been merged away", () => {
    const sessionA = key(4);
    const sessionB = key(5);
    const locked = [
      created("alpha", "甲", DAY_BEFORE),
      refined(sessionA, "标题", "概要", DAY_BEFORE),
      assigned("alpha", sessionA, DAY_BEFORE),
      ev("topic.status_changed", { topicId: "alpha", status: "follow_up", by: "user" }, DAY_BEFORE),
      ev(
        "conclusion.added",
        { conclusionId: "c1", topicId: "alpha", text: "新结论", sessionKey: sessionA },
        DAY_OF,
      ),
    ];
    expect(changed(locked)).toEqual([]);

    const merged = [
      created("from", "旧", DAY_BEFORE),
      created("into", "新", DAY_BEFORE),
      refined(sessionA, "旧标题", "旧概要", DAY_BEFORE),
      refined(sessionB, "新标题", "新概要", DAY_BEFORE),
      assigned("from", sessionA, DAY_BEFORE),
      assigned("into", sessionB, DAY_BEFORE),
      ev("topic.merged", { fromTopicId: "from", intoTopicId: "into" }, DAY_BEFORE),
      ev(
        "conclusion.added",
        { conclusionId: "c1", topicId: "from", text: "并进来的结论", sessionKey: sessionA },
        DAY_OF,
      ),
    ];
    expect(changed(merged)).toEqual(["into"]);
  });

  it("still rewrites a changed topic that sits in the history zone", () => {
    const older = key(6);
    const newer = key(7);
    const events = [
      created("old", "旧", DAY_BEFORE),
      created("new", "新", DAY_BEFORE),
      refined(older, "旧标题", "旧概要", DAY_BEFORE),
      refined(newer, "新标题", "新概要", DAY_BEFORE),
      assigned("old", older, DAY_BEFORE),
      assigned("new", newer, DAY_BEFORE),
      ev(
        "conclusion.added",
        { conclusionId: "c-old", topicId: "old", text: "历史区也有变化", sessionKey: older },
        DAY_OF,
      ),
      ev(
        "conclusion.added",
        { conclusionId: "c-new", topicId: "new", text: "活跃区变化", sessionKey: newer },
        DAY_OF,
      ),
    ];
    const ids = changed(events, {
      activeLimit: 1,
      sessionUpdatedAt: { [older]: DAY_BEFORE, [newer]: DAY_OF },
    });
    expect(ids.sort()).toEqual(["new", "old"]);
  });

  it("splits the same instant across UTC+8 and UTC-8", () => {
    const session = key(8);
    const instant = "2026-10-23T04:00:00.000Z";
    const events = [
      created("alpha", "甲", "2026-10-21T00:00:00.000Z"),
      refined(session, "标题", "概要", "2026-10-21T00:00:00.000Z"),
      assigned("alpha", session, "2026-10-21T00:00:00.000Z"),
    ];
    const patch = { sessionUpdatedAt: { [session]: instant }, now: instant };
    expect(changed(events, { ...patch, day: "2026-10-23", timeZone: SHANGHAI })).toEqual([
      "alpha",
    ]);
    expect(changed(events, { ...patch, day: "2026-10-23", timeZone: PITCAIRN })).toEqual([]);
    expect(changed(events, { ...patch, day: "2026-10-22", timeZone: PITCAIRN })).toEqual([
      "alpha",
    ]);
  });
});

describe("recentTopicSessions", () => {
  it("keeps at most 12 sessions and prefers ones that changed that day", () => {
    const events = [created("alpha", "甲", DAY_BEFORE)];
    const updated: Record<string, string> = {};
    for (let index = 0; index < 13; index += 1) {
      const session = key(20 + index);
      events.push(refined(session, `标题${index}`, "概要", DAY_BEFORE));
      events.push(assigned("alpha", session, DAY_BEFORE));
      updated[session] = index === 0 ? DAY_OF : DAY_BEFORE;
    }
    const book = fold(events);
    const recent = recentTopicSessions({
      book,
      topicId: "alpha",
      sessionUpdatedAt: updated,
      day: LOCAL_DAY,
      timeZone: SHANGHAI,
    });
    expect(recent).toHaveLength(12);
    expect(recent[0]?.sessionKey).toBe(key(20));
    expect(recent.some((session) => session.sessionKey === key(32))).toBe(false);
  });
});

describe("selectMergeCandidates", () => {
  it("keeps the 40 most recently active topics and puts nulls last", () => {
    const topics: ZonedTopic[] = [];
    for (let index = 0; index < 41; index += 1) {
      topics.push(zoned(`t${String(index).padStart(2, "0")}`, `2026-10-01T00:${String(index).padStart(2, "0")}:00.000Z`));
    }
    topics.push(zoned("quiet", null));
    const picked = selectMergeCandidates(topics);
    expect(picked).toHaveLength(40);
    expect(picked[0]?.topicId).toBe("t40");
    expect(picked.some((topic) => topic.topicId === "quiet")).toBe(false);
    expect(picked.some((topic) => topic.topicId === "t00")).toBe(false);
  });
});

function zoned(topicId: string, lastActive: string | null): ZonedTopic {
  return {
    topicId,
    name: topicId,
    aliases: [],
    status: "active",
    statusBy: "auto",
    summary: "",
    nextStep: "",
    mergedInto: null,
    createdTs: null,
    lastUserOpAt: null,
    lastContentAt: null,
    userLocked: false,
    lastActive,
    zone: "history",
  };
}

// --- Reference legacy implementations for differential testing ---

function legacyResolveMergedTopic(book: TopicBook, topicId: string): string {
  const byId = new Map(book.topics.map((topic) => [topic.topicId, topic]));
  let current = topicId;
  const seen = new Set<string>();
  while (true) {
    const next = byId.get(current)?.mergedInto;
    if (!next || seen.has(current)) return current;
    seen.add(current);
    current = next;
  }
}

function legacySelectTopicsChangedOnDay(input: {
  book: TopicBook;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  day: string;
  timeZone: string;
  now: string;
  activeLimit: number;
  historyDays: number;
}) {
  const zonedTopics = partitionTopics(input.book, {
    now: input.now,
    activeLimit: input.activeLimit,
    historyDays: input.historyDays,
    sessionUpdatedAt: input.sessionUpdatedAt,
  });
  const visible = [...zonedTopics.active, ...zonedTopics.history];
  const changed: Array<{ topic: ZonedTopic; lastChangeMs: number }> = [];
  for (const topic of visible) {
    if (topic.userLocked || topic.mergedInto !== null) continue;
    const stamps: number[] = [];
    const consider = (iso: string | null | undefined): void => {
      if (!iso || !instantOnLocalDay(iso, input.day, input.timeZone)) return;
      const ms = Date.parse(iso);
      if (!Number.isNaN(ms)) stamps.push(ms);
    };
    for (const session of input.book.sessions) {
      if (session.topicId !== topic.topicId) continue;
      consider(input.sessionUpdatedAt[session.sessionKey]);
    }
    for (const event of input.book.memory.log) {
      switch (event.type) {
        case "topic.assigned":
          if (legacyResolveMergedTopic(input.book, event.data.topicId) === topic.topicId) {
            consider(event.ts);
          }
          break;
        case "session.refined": {
          const session = input.book.sessions.find((item) => item.sessionKey === event.data.sessionKey);
          if (session?.topicId === topic.topicId) consider(event.ts);
          break;
        }
        case "conclusion.added":
        case "todo.added":
          if (legacyResolveMergedTopic(input.book, event.data.topicId) === topic.topicId) {
            consider(event.ts);
          }
          break;
        default:
          break;
      }
    }
    if (stamps.length === 0) continue;
    changed.push({ topic, lastChangeMs: Math.max(...stamps) });
  }
  changed.sort((left, right) => {
    if (left.lastChangeMs !== right.lastChangeMs) return right.lastChangeMs - left.lastChangeMs;
    return left.topic.topicId < right.topic.topicId ? -1 : 1;
  });
  return changed;
}

function legacySelectChangedTopics(input: {
  book: TopicBook;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  day: string;
  timeZone: string;
  now: string;
  activeLimit: number;
  historyDays: number;
}) {
  return legacySelectTopicsChangedOnDay(input).filter((item) => {
    let best: number | null = null;
    for (const event of input.book.memory.log) {
      if (event.type !== "topic.summary_rewritten") continue;
      if (legacyResolveMergedTopic(input.book, event.data.topicId) !== item.topic.topicId) continue;
      const ms = Date.parse(event.ts);
      if (Number.isNaN(ms)) continue;
      if (best === null || ms > best) best = ms;
    }
    return best === null || best <= item.lastChangeMs;
  });
}

function legacyRecentTopicSessions(input: {
  book: TopicBook;
  topicId: string;
  sessionUpdatedAt: Readonly<Record<string, string>>;
  day: string;
  timeZone: string;
}): SessionState[] {
  const sessions = input.book.sessions.filter((session) => session.topicId === input.topicId);
  const ranked = sessions.map((session) => {
    let onDay = false;
    let ms = Number.NEGATIVE_INFINITY;
    const consider = (iso: string | null | undefined): void => {
      if (!iso) return;
      const parsed = Date.parse(iso);
      if (Number.isNaN(parsed)) return;
      if (instantOnLocalDay(iso, input.day, input.timeZone)) onDay = true;
      if (parsed > ms) ms = parsed;
    };
    consider(input.sessionUpdatedAt[session.sessionKey]);
    for (const event of input.book.memory.log) {
      if (
        (event.type === "session.refined" ||
          event.type === "conclusion.added" ||
          event.type === "todo.added" ||
          event.type === "topic.assigned") &&
        event.data.sessionKey === session.sessionKey
      ) {
        consider(event.ts);
      }
    }
    return { session, onDay, ms };
  });
  ranked.sort((left, right) => {
    if (left.onDay !== right.onDay) return left.onDay ? -1 : 1;
    if (left.ms !== right.ms) return right.ms - left.ms;
    return left.session.sessionKey < right.session.sessionKey ? -1 : 1;
  });
  return ranked.slice(0, RECENT_SESSIONS).map((item) => item.session);
}

function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("select differential and complexity checks", () => {
  it("matches legacy results across multi-hop merges, cycles, DST boundaries, and invalid timestamps", () => {
    const rand = makePrng(20261119);
    const topicIds = Array.from({ length: 24 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const sessionKeys = Array.from({ length: 40 }, (_, i) => key(100 + i));
    const baseMs = Date.parse("2026-10-31T00:00:00.000Z"); // Covers America/New_York DST fall-back 2026-11-01
    const pickValidTs = () => {
      const offsetMs = Math.floor(rand() * 4 * 24 * 60 * 60 * 1000);
      return new Date(baseMs + offsetMs).toISOString();
    };

    const events: Event[] = [];
    for (let i = 0; i < topicIds.length; i += 1) {
      events.push(created(topicIds[i]!, `话题${i}`, "2026-10-25T00:00:00.000Z"));
    }
    // Multi-hop merge chain: t00 -> t01 -> t02 -> t03
    events.push(
      ev("topic.merged", { fromTopicId: "t00", intoTopicId: "t01" }, "2026-10-26T00:00:00.000Z"),
      ev("topic.merged", { fromTopicId: "t01", intoTopicId: "t02" }, "2026-10-26T01:00:00.000Z"),
      ev("topic.merged", { fromTopicId: "t02", intoTopicId: "t03" }, "2026-10-26T02:00:00.000Z"),
      ev("topic.status_changed", { topicId: "t04", status: "follow_up", by: "user" }, "2026-10-26T03:00:00.000Z"),
    );

    for (let i = 0; i < sessionKeys.length; i += 1) {
      const sk = sessionKeys[i]!;
      const tid = topicIds[Math.floor(rand() * topicIds.length)]!;
      events.push(refined(sk, `会话${i}`, "摘要", "2026-10-28T00:00:00.000Z"));
      events.push(assigned(tid, sk, "2026-10-28T01:00:00.000Z"));
    }

    for (let i = 0; i < 240; i += 1) {
      const tid = topicIds[Math.floor(rand() * topicIds.length)]!;
      const sk = sessionKeys[Math.floor(rand() * sessionKeys.length)]!;
      const ts = pickValidTs();
      const roll = rand();
      if (roll < 0.25) {
        events.push(ev("conclusion.added", { conclusionId: `c-${i}`, topicId: tid, text: "结论", sessionKey: sk }, ts));
      } else if (roll < 0.5) {
        events.push(ev("todo.added", { todoId: `td-${i}`, topicId: tid, text: "待办", sessionKey: sk, confidence: 0.9 }, ts));
      } else if (roll < 0.7) {
        events.push(refined(sk, `更新${i}`, "摘要", ts));
      } else if (roll < 0.85) {
        events.push(assigned(tid, sk, ts));
      } else {
        events.push(ev("topic.summary_rewritten", { topicId: tid, summary: `重${i}`, nextStep: "" }, ts));
      }
    }

    const folded = fold(events);
    // Inject synthetic invalid-timestamp log entries to verify parity on bad timestamps.
    const badEvent: Event = {
      ...ev("conclusion.added", { conclusionId: "c-bad", topicId: "t05", text: "坏时间", sessionKey: sessionKeys[0]! }, "2026-11-01T00:00:00.000Z"),
      ts: "not-a-timestamp",
    };
    const badRewrite: Event = {
      ...ev("topic.summary_rewritten", { topicId: "t05", summary: "坏重写", nextStep: "" }, "2026-11-01T00:00:00.000Z"),
      ts: "not-a-timestamp",
    };
    const book: TopicBook = {
      ...folded,
      memory: { ...folded.memory, log: [...folded.memory.log, badEvent, badRewrite] },
    };
    // Inject a synthetic cycle directly on a copied book to verify cycle parity with legacy resolver.
    const cyclicBook: TopicBook = {
      ...book,
      topics: [
        ...book.topics,
        {
          topicId: "cyc-a",
          name: "环A",
          aliases: [],
          status: "active",
          statusBy: "auto",
          summary: "",
          nextStep: "",
          mergedInto: "cyc-b",
          createdTs: null,
          lastUserOpAt: null,
          lastContentAt: null,
          userLocked: false,
        },
        {
          topicId: "cyc-b",
          name: "环B",
          aliases: [],
          status: "active",
          statusBy: "auto",
          summary: "",
          nextStep: "",
          mergedInto: "cyc-a",
          createdTs: null,
          lastUserOpAt: null,
          lastContentAt: null,
          userLocked: false,
        },
      ],
    };
    const resolver = createMergedTopicResolver(cyclicBook);
    expect(resolver("cyc-a")).toBe(legacyResolveMergedTopic(cyclicBook, "cyc-a"));
    expect(resolver("cyc-b")).toBe(legacyResolveMergedTopic(cyclicBook, "cyc-b"));
    expect(resolver("t00")).toBe("t03");
    expect(resolver("t01")).toBe("t03");

    const sessionUpdatedAt: Record<string, string> = {};
    for (const sk of sessionKeys) {
      if (rand() < 0.6) sessionUpdatedAt[sk] = rand() < 0.08 ? "not-a-timestamp" : pickValidTs();
    }

    const cases = [
      { day: "2026-11-01", timeZone: "America/New_York" },
      { day: "2026-11-02", timeZone: "Asia/Shanghai" },
      { day: "2026-11-01", timeZone: PITCAIRN },
      { day: "2026-11-01", timeZone: "Invalid/Zone" },
    ];
    for (const { day, timeZone } of cases) {
      const input = {
        book,
        sessionUpdatedAt,
        day,
        timeZone,
        now: "2026-11-04T00:00:00.000Z",
        activeLimit: 8,
        historyDays: 30,
      };
      expect(selectTopicsChangedOnDay(input)).toEqual(legacySelectTopicsChangedOnDay(input));
      expect(selectChangedTopics(input)).toEqual(legacySelectChangedTopics(input));
      for (const tid of ["t03", "t05", "t10"]) {
        expect(
          recentTopicSessions({ book, topicId: tid, sessionUpdatedAt, day, timeZone }),
        ).toEqual(
          legacyRecentTopicSessions({ book, topicId: tid, sessionUpdatedAt, day, timeZone }),
        );
      }
    }
  });

  it("scans memory.log once and topics a constant number of times regardless of topic count", () => {
    const events: Event[] = [];
    for (let i = 0; i < 60; i += 1) {
      events.push(created(`t${i}`, `话题${i}`, DAY_BEFORE));
    }
    for (let i = 0; i < 200; i += 1) {
      const sk = key(500 + (i % 40));
      const tid = `t${i % 60}`;
      events.push(refined(sk, `s${i}`, "sum", DAY_OF));
      events.push(assigned(tid, sk, DAY_OF));
      events.push(ev("conclusion.added", { conclusionId: `c${i}`, topicId: tid, text: "x", sessionKey: sk }, DAY_OF));
      events.push(ev("topic.summary_rewritten", { topicId: tid, summary: "r", nextStep: "" }, DAY_BEFORE));
    }
    const base = fold(events);
    let logIterations = 0;
    let topicIterations = 0;
    const proxiedLog = new Proxy(base.memory.log, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) {
          logIterations += 1;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const proxiedTopics = new Proxy(base.topics, {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) {
          topicIterations += 1;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const instrumented: TopicBook = {
      ...base,
      topics: proxiedTopics,
      memory: { ...base.memory, log: proxiedLog },
    };

    const result = selectChangedTopics({
      book: instrumented,
      sessionUpdatedAt: {},
      day: LOCAL_DAY,
      timeZone: SHANGHAI,
      now: LATER,
      activeLimit: 10,
      historyDays: 30,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(logIterations).toBe(1);
    // Once inside createMergedTopicResolver, plus constant passes inside partitionTopics.
    expect(topicIterations).toBeLessThanOrEqual(4);
  });
});
