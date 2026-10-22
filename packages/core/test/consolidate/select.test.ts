import { describe, expect, it } from "bun:test";

import {
  recentTopicSessions,
  selectChangedTopics,
  selectMergeCandidates,
} from "../../src/consolidate/select.js";
import type { ZonedTopic } from "../../src/topics/types.js";
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
    userLocked: false,
    lastActive,
    zone: "history",
  };
}
