import { describe, expect, it } from "bun:test";

import {
  applyEvents,
  canonicalTopicName,
  foldEvents,
  resolveMergedTopic,
  topicBookView,
} from "../../src/topics/index.js";
import { KEY_1, KEY_2, buildEvent, plus } from "./helpers.js";

describe("canonical topic names", () => {
  it("lowercases and strips whitespace and punctuation", () => {
    expect(canonicalTopicName("You-Brain 设计")).toBe("youbrain设计");
    expect(canonicalTopicName("you brain设计")).toBe("youbrain设计");
    expect(canonicalTopicName("You_Brain设计")).toBe("youbrain设计");
    expect(canonicalTopicName("YOU.BRAIN设计")).toBe("youbrain设计");
    expect(canonicalTopicName("You Brain，设计")).toBe("youbrain设计");
    expect(canonicalTopicName("A\u3000B")).toBe("ab");
    expect(canonicalTopicName("???")).toBe("");
    expect(canonicalTopicName("!!!")).toBe("");
  });
});

describe("event fold", () => {
  it("starts empty and ignores duplicate ids", () => {
    expect(topicBookView(foldEvents([]))).toEqual({
      topics: [],
      sessions: [],
      conclusions: [],
      todos: [],
    });
    const added = buildEvent({
      type: "conclusion.added",
      data: {
        conclusionId: "c1",
        topicId: "topic-a",
        text: "shipped",
        sessionKey: KEY_1,
      },
      device: "dev-a",
      ts: plus(2),
      seq: 1,
    });
    const created = buildEvent({
      type: "topic.created",
      data: { topicId: "topic-a", name: "Alpha", aliases: [] },
      device: "dev-a",
      ts: plus(1),
      seq: 1,
    });
    const once = topicBookView(foldEvents([added, created]));
    const twice = topicBookView(foldEvents([added, created, added, created]));
    expect(twice).toEqual(once);
    expect(twice.conclusions).toHaveLength(1);
    expect(topicBookView(foldEvents([created, added].reverse()))).toEqual(once);
  });

  it("keeps the latest field values, including a later create over an earlier rename", () => {
    const rename = buildEvent({
      type: "topic.renamed",
      data: { topicId: "topic-a", name: "Beta", aliases: ["b"] },
      device: "dev-b",
      ts: plus(1),
      seq: 1,
    });
    const created = buildEvent({
      type: "topic.created",
      data: { topicId: "topic-a", name: "Alpha", aliases: ["a"] },
      device: "dev-a",
      ts: plus(2),
      seq: 1,
    });
    const again = buildEvent({
      type: "topic.renamed",
      data: { topicId: "topic-a", name: "Gamma", aliases: ["g"] },
      device: "dev-a",
      ts: plus(3),
      seq: 2,
    });
    const book = foldEvents([again, rename, created]);
    expect(book.topics[0]).toMatchObject({
      name: "Gamma",
      aliases: ["g"],
      createdTs: plus(2),
    });
  });

  it("lets a user status block later auto status until the user changes it again", () => {
    const topic = {
      type: "topic.created" as const,
      data: { topicId: "topic-a", name: "Alpha", aliases: [] as string[] },
    };
    const created = buildEvent({
      ...topic,
      device: "dev-a",
      ts: plus(1),
      seq: 1,
    });
    const autoFirst = buildEvent({
      type: "topic.status_changed",
      data: { topicId: "topic-a", status: "follow_up", by: "auto" },
      device: "dev-a",
      ts: plus(2),
      seq: 1,
    });
    const userDone = buildEvent({
      type: "topic.status_changed",
      data: { topicId: "topic-a", status: "done", by: "user" },
      device: "dev-b",
      ts: plus(3),
      seq: 1,
    });
    const autoLater = buildEvent({
      type: "topic.status_changed",
      data: { topicId: "topic-a", status: "active", by: "auto" },
      device: "dev-a",
      ts: plus(4),
      seq: 2,
    });
    const userParked = buildEvent({
      type: "topic.status_changed",
      data: { topicId: "topic-a", status: "parked", by: "user" },
      device: "dev-b",
      ts: plus(5),
      seq: 2,
    });
    const book = foldEvents([autoLater, userParked, created, userDone, autoFirst]);
    expect(book.topics[0]).toMatchObject({
      status: "parked",
      statusBy: "user",
      userLocked: true,
      lastUserOpAt: plus(5),
    });

    const sameTs = plus(10);
    const userFirst = foldEvents([
      created,
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: "topic-a", status: "done", by: "user" },
        device: "dev-a",
        ts: sameTs,
        seq: 1,
      }),
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: "topic-a", status: "active", by: "auto" },
        device: "dev-b",
        ts: sameTs,
        seq: 1,
      }),
    ]);
    const autoSortsFirst = foldEvents([
      created,
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: "topic-a", status: "active", by: "auto" },
        device: "dev-a",
        ts: sameTs,
        seq: 1,
      }),
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: "topic-a", status: "done", by: "user" },
        device: "dev-b",
        ts: sameTs,
        seq: 1,
      }),
    ]);
    expect(userFirst.topics[0]).toMatchObject({ status: "done", userLocked: true });
    expect(autoSortsFirst.topics[0]).toMatchObject({
      status: "done",
      statusBy: "user",
      userLocked: true,
    });
  });

  it("keeps the session.refined snapshot with the greatest refinedUpTo", () => {
    const low = buildEvent({
      type: "session.refined",
      data: {
        sessionKey: KEY_1,
        fileId: "file-low",
        source: "codex",
        title: "low",
        summary: "old",
        refinedUpTo: 2,
      },
      device: "dev-a",
      ts: plus(1),
      seq: 1,
    });
    const high = buildEvent({
      type: "session.refined",
      data: {
        sessionKey: KEY_1,
        fileId: "file-high",
        source: "claude-code",
        title: "high",
        summary: "new",
        refinedUpTo: 5,
      },
      device: "dev-b",
      ts: plus(2),
      seq: 1,
    });
    const tie = buildEvent({
      type: "session.refined",
      data: {
        sessionKey: KEY_1,
        fileId: "file-tie",
        source: "cursor",
        title: "tie",
        summary: "same watermark",
        refinedUpTo: 5,
      },
      device: "dev-c",
      ts: plus(3),
      seq: 1,
    });
    const stale = buildEvent({
      type: "session.refined",
      data: {
        sessionKey: KEY_1,
        fileId: "file-stale",
        source: "grok-build",
        title: "stale",
        summary: "ignored",
        refinedUpTo: 4,
      },
      device: "dev-a",
      ts: plus(4),
      seq: 2,
    });
    const book = foldEvents([stale, low, tie, high]);
    expect(book.sessions[0]).toEqual({
      sessionKey: KEY_1,
      source: "cursor",
      fileId: "file-tie",
      title: "tie",
      summary: "same watermark",
      refinedUpTo: 5,
      topicId: null,
    });
  });

  it("redirects events through a merge chain, including ones sorted before the merge", () => {
    const events = [
      buildEvent({
        type: "topic.created",
        data: { topicId: "topic-a", name: "A", aliases: [] },
        device: "dev-a",
        ts: plus(1),
        seq: 1,
      }),
      buildEvent({
        type: "topic.created",
        data: { topicId: "topic-b", name: "B", aliases: [] },
        device: "dev-b",
        ts: plus(1),
        seq: 1,
      }),
      buildEvent({
        type: "topic.created",
        data: { topicId: "topic-c", name: "C", aliases: [] },
        device: "dev-c",
        ts: plus(1),
        seq: 1,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-a", sessionKey: KEY_1 },
        device: "dev-a",
        ts: plus(2),
        seq: 2,
      }),
      buildEvent({
        type: "conclusion.added",
        data: {
          conclusionId: "c1",
          topicId: "topic-a",
          text: "kept",
          sessionKey: KEY_1,
        },
        device: "dev-a",
        ts: plus(3),
        seq: 3,
      }),
      buildEvent({
        type: "todo.added",
        data: {
          todoId: "todo-1",
          topicId: "topic-a",
          text: "follow up",
          sessionKey: KEY_1,
          confidence: 0.5,
        },
        device: "dev-b",
        ts: plus(4),
        seq: 2,
      }),
      buildEvent({
        type: "topic.merged",
        data: { fromTopicId: "topic-a", intoTopicId: "topic-b" },
        device: "dev-a",
        ts: plus(5),
        seq: 4,
      }),
      buildEvent({
        type: "topic.merged",
        data: { fromTopicId: "topic-b", intoTopicId: "topic-c" },
        device: "dev-b",
        ts: plus(6),
        seq: 3,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-a", sessionKey: KEY_2 },
        device: "dev-c",
        ts: plus(7),
        seq: 2,
      }),
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: "topic-a", status: "done", by: "user" },
        device: "dev-a",
        ts: plus(8),
        seq: 5,
      }),
      buildEvent({
        type: "topic.summary_rewritten",
        data: { topicId: "topic-b", summary: "rolled up", nextStep: "ship" },
        device: "dev-b",
        ts: plus(9),
        seq: 4,
      }),
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: "topic-c", status: "active", by: "auto" },
        device: "dev-c",
        ts: plus(10),
        seq: 3,
      }),
    ];
    const book = foldEvents([...events].reverse());
    expect(resolveMergedTopic(book, "topic-a")).toBe("topic-c");
    expect(resolveMergedTopic(book, "topic-b")).toBe("topic-c");
    expect(book.topics.find((topic) => topic.topicId === "topic-a")?.mergedInto).toBe(
      "topic-b",
    );
    expect(book.topics.find((topic) => topic.topicId === "topic-b")?.mergedInto).toBe(
      "topic-c",
    );
    expect(book.sessions.map((session) => session.topicId)).toEqual(["topic-c", "topic-c"]);
    expect(book.conclusions[0]?.topicId).toBe("topic-c");
    expect(book.todos[0]?.topicId).toBe("topic-c");
    expect(book.topics.find((topic) => topic.topicId === "topic-c")).toMatchObject({
      status: "done",
      statusBy: "user",
      userLocked: true,
      summary: "rolled up",
      nextStep: "ship",
    });
  });

  it("auto-merges concurrent creates that share a canonical name", () => {
    const ts = plus(1);
    const events = [
      buildEvent({
        type: "topic.created",
        data: { topicId: "id-c", name: "Foo Bar!", aliases: ["c"] },
        device: "dev-a",
        ts,
        seq: 1,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "id-c", sessionKey: KEY_1 },
        device: "dev-a",
        ts,
        seq: 2,
      }),
      buildEvent({
        type: "topic.created",
        data: { topicId: "id-b", name: "foo-bar", aliases: ["b"] },
        device: "dev-b",
        ts,
        seq: 1,
      }),
      buildEvent({
        type: "topic.created",
        data: { topicId: "id-a", name: "FOO BAR", aliases: ["winner"] },
        device: "dev-c",
        ts,
        seq: 1,
      }),
    ];
    const book = foldEvents([...events].reverse());
    expect(book.topics.find((topic) => topic.topicId === "id-a")).toMatchObject({
      name: "FOO BAR",
      aliases: ["winner"],
      mergedInto: null,
    });
    expect(book.topics.find((topic) => topic.topicId === "id-b")?.mergedInto).toBe("id-a");
    expect(book.topics.find((topic) => topic.topicId === "id-c")?.mergedInto).toBe("id-b");
    expect(resolveMergedTopic(book, "id-c")).toBe("id-a");
    expect(book.sessions[0]?.topicId).toBe("id-a");

    const earlierWins = foldEvents([
      buildEvent({
        type: "topic.created",
        data: { topicId: "id-z", name: "Foo", aliases: [] },
        device: "dev-b",
        ts: plus(1),
        seq: 1,
      }),
      buildEvent({
        type: "topic.created",
        data: { topicId: "id-a", name: "foo", aliases: [] },
        device: "dev-a",
        ts: plus(2),
        seq: 1,
      }),
    ]);
    expect(earlierWins.topics.find((topic) => topic.topicId === "id-a")?.mergedInto).toBe(
      "id-z",
    );
    expect(earlierWins.topics.find((topic) => topic.topicId === "id-z")?.mergedInto).toBeNull();

    const punctuation = foldEvents([
      buildEvent({
        type: "topic.created",
        data: { topicId: "dots", name: "???", aliases: [] },
        device: "dev-b",
        ts,
        seq: 1,
      }),
      buildEvent({
        type: "topic.created",
        data: { topicId: "bangs", name: "!!!", aliases: [] },
        device: "dev-a",
        ts,
        seq: 1,
      }),
    ]);
    expect(punctuation.topics.find((topic) => topic.topicId === "dots")?.mergedInto).toBe(
      "bangs",
    );
  });

  it("does not auto-merge a rename onto an existing canonical name", () => {
    const book = foldEvents([
      buildEvent({
        type: "topic.created",
        data: { topicId: "topic-a", name: "Alpha", aliases: [] },
        device: "dev-a",
        ts: plus(1),
        seq: 1,
      }),
      buildEvent({
        type: "topic.created",
        data: { topicId: "topic-b", name: "Beta", aliases: [] },
        device: "dev-b",
        ts: plus(2),
        seq: 1,
      }),
      buildEvent({
        type: "topic.renamed",
        data: { topicId: "topic-b", name: "Alpha", aliases: ["renamed"] },
        device: "dev-b",
        ts: plus(3),
        seq: 2,
      }),
    ]);
    expect(book.topics.map((topic) => topic.mergedInto)).toEqual([null, null]);
    expect(book.topics.find((topic) => topic.topicId === "topic-b")).toMatchObject({
      name: "Alpha",
      aliases: ["renamed"],
      lastUserOpAt: plus(3),
    });
  });

  it("applies todo user priority and a status that arrives before todo.added", () => {
    const book = foldEvents([
      buildEvent({
        type: "topic.created",
        data: { topicId: "topic-a", name: "Alpha", aliases: [] },
        device: "dev-a",
        ts: plus(1),
        seq: 1,
      }),
      buildEvent({
        type: "todo.status_changed",
        data: { todoId: "todo-1", status: "done", by: "user" },
        device: "dev-b",
        ts: plus(2),
        seq: 1,
      }),
      buildEvent({
        type: "todo.added",
        data: {
          todoId: "todo-1",
          topicId: "topic-a",
          text: "ship",
          sessionKey: KEY_1,
          confidence: 0.5,
        },
        device: "dev-a",
        ts: plus(3),
        seq: 2,
      }),
      buildEvent({
        type: "todo.status_changed",
        data: { todoId: "todo-1", status: "dropped", by: "auto" },
        device: "dev-c",
        ts: plus(4),
        seq: 1,
      }),
    ]);
    expect(book.todos[0]).toMatchObject({
      topicId: "topic-a",
      text: "ship",
      status: "done",
      statusBy: "user",
      userLocked: true,
      ts: plus(3),
    });
    expect(book.topics[0]?.lastUserOpAt).toBe(plus(2));
  });

  it("does not create a topic for a digest reminder", () => {
    const book = foldEvents([
      buildEvent({
        type: "reminder.issued",
        data: {
          reminderId: "morning:2026-10-21",
          kind: "morning_digest",
          topicId: null,
          text: "早报",
        },
        device: "dev-a",
        ts: plus(1),
        seq: 1,
      }),
      buildEvent({
        type: "reminder.action",
        data: {
          reminderId: "morning:2026-10-21",
          topicId: null,
          action: "ignore",
          until: null,
        },
        device: "dev-a",
        ts: plus(2),
        seq: 2,
      }),
    ]);
    expect(book.topics).toEqual([]);
  });

  it("counts a reminder action as user activity and ignores portrait events", () => {
    const created = buildEvent({
      type: "topic.created",
      data: { topicId: "topic-a", name: "Alpha", aliases: [] },
      device: "dev-a",
      ts: plus(2),
      seq: 1,
    });
    const reminder = buildEvent({
      type: "reminder.action",
      data: {
        reminderId: "rem-1",
        topicId: "topic-a",
        action: "reactivate",
        until: null,
      },
      device: "dev-a",
      ts: plus(1),
      seq: 1,
    });
    const portrait = buildEvent({
      type: "portrait.correction",
      data: {
        correctionId: "corr-1",
        variant: "coding",
        section: "style",
        text: "short functions",
      },
      device: "dev-b",
      ts: plus(3),
      seq: 1,
    });
    const withExtra = foldEvents([portrait, created, reminder]);
    expect(withExtra.topics[0]).toMatchObject({
      status: "active",
      lastUserOpAt: plus(1),
    });
    expect(topicBookView(foldEvents([created, reminder]))).toEqual(topicBookView(withExtra));
  });

  it("replays when a new event sorts before the last applied event", () => {
    const created = buildEvent({
      type: "topic.created",
      data: { topicId: "topic-a", name: "Seed", aliases: [] },
      device: "dev-a",
      ts: plus(1),
      seq: 1,
    });
    const later = buildEvent({
      type: "topic.renamed",
      data: { topicId: "topic-a", name: "Beta", aliases: ["b"] },
      device: "dev-a",
      ts: plus(3),
      seq: 2,
    });
    const earlier = buildEvent({
      type: "topic.renamed",
      data: { topicId: "topic-a", name: "Alpha", aliases: ["a"] },
      device: "dev-b",
      ts: plus(2),
      seq: 1,
    });
    const book = foldEvents([created, later]);
    const before = topicBookView(book);
    const next = applyEvents(book, [earlier]);
    expect(topicBookView(book)).toEqual(before);
    expect(next.topics[0]?.name).toBe("Beta");
    expect(topicBookView(next)).toEqual(
      topicBookView(foldEvents([created, later, earlier])),
    );
    expect(topicBookView(applyEvents(next, [earlier, later]))).toEqual(topicBookView(next));
  });

  it("appends events that sort after the last applied event", () => {
    const created = buildEvent({
      type: "topic.created",
      data: { topicId: "topic-a", name: "Seed", aliases: [] },
      device: "dev-a",
      ts: plus(1),
      seq: 1,
    });
    const later = buildEvent({
      type: "topic.renamed",
      data: { topicId: "topic-a", name: "Beta", aliases: [] },
      device: "dev-a",
      ts: plus(2),
      seq: 2,
    });
    const after = buildEvent({
      type: "topic.renamed",
      data: { topicId: "topic-a", name: "Gamma", aliases: ["g"] },
      device: "dev-b",
      ts: plus(3),
      seq: 1,
    });
    const stepped = applyEvents(foldEvents([created, later]), [after]);
    expect(stepped.topics[0]?.name).toBe("Gamma");
    expect(topicBookView(stepped)).toEqual(
      topicBookView(foldEvents([after, created, later])),
    );
  });
});
