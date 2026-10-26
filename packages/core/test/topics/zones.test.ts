import { describe, expect, it } from "bun:test";

import { deriveLastActive, foldEvents, partitionTopics } from "../../src/topics/index.js";
import { buildEvent, plus, sessionKey } from "./helpers.js";

const NOW = "2026-08-01T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

function created(topicId: string, name: string, seq: number) {
  return buildEvent({
    type: "topic.created",
    data: { topicId, name, aliases: [] },
    device: "dev-a",
    ts: plus(seq),
    seq,
  });
}

describe("active and history zones", () => {
  it("derives zones from lastActive, status, limit, and history days", () => {
    const book = foldEvents([
      created("topic-new", "New", 1),
      created("topic-mid", "Mid", 2),
      created("topic-old", "Old", 3),
      created("topic-done", "Done", 4),
      created("topic-parked", "Parked", 5),
      created("topic-empty", "Empty", 6),
      created("topic-dead", "Dead", 7),
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: "topic-done", status: "done", by: "auto" },
        device: "dev-b",
        ts: plus(8),
        seq: 1,
      }),
      buildEvent({
        type: "topic.status_changed",
        data: { topicId: "topic-parked", status: "parked", by: "auto" },
        device: "dev-b",
        ts: plus(9),
        seq: 2,
      }),
      buildEvent({
        type: "topic.merged",
        data: { fromTopicId: "topic-dead", intoTopicId: "topic-new" },
        device: "dev-c",
        ts: plus(10),
        seq: 1,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-new", sessionKey: sessionKey(11) },
        device: "dev-a",
        ts: plus(11),
        seq: 11,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-mid", sessionKey: sessionKey(12) },
        device: "dev-a",
        ts: plus(12),
        seq: 12,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-old", sessionKey: sessionKey(13) },
        device: "dev-a",
        ts: plus(13),
        seq: 13,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-done", sessionKey: sessionKey(14) },
        device: "dev-a",
        ts: plus(14),
        seq: 14,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-parked", sessionKey: sessionKey(15) },
        device: "dev-a",
        ts: plus(15),
        seq: 15,
      }),
    ]);
    const zones = partitionTopics(book, {
      now: NOW,
      activeLimit: 2,
      historyDays: 30,
      sessionUpdatedAt: {
        [sessionKey(11)]: "2026-07-31T00:00:00.000Z",
        [sessionKey(12)]: "2026-07-20T00:00:00.000Z",
        [sessionKey(13)]: "2026-06-01T00:00:00.000Z",
        [sessionKey(14)]: "2026-07-31T00:00:00.000Z",
        [sessionKey(15)]: "2026-07-30T00:00:00.000Z",
      },
    });
    expect(zones.active.map((topic) => topic.topicId)).toEqual([
      "topic-new",
      "topic-parked",
    ]);
    expect(zones.history.map((topic) => topic.topicId)).toEqual([
      "topic-done",
      "topic-mid",
      "topic-old",
      "topic-empty",
    ]);
    expect(zones.active.concat(zones.history).map((topic) => topic.topicId)).not.toContain(
      "topic-dead",
    );
    expect(zones.active[0]?.lastActive).toBe("2026-07-31T00:00:00.000Z");
    expect(zones.active.every((topic) => topic.zone === "active")).toBe(true);
    expect(zones.history.every((topic) => topic.zone === "history")).toBe(true);
  });

  it("uses the later of session updatedAt and the last user operation", () => {
    const book = foldEvents([
      created("topic-a", "Alpha", 1),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-a", sessionKey: sessionKey(21) },
        device: "dev-a",
        ts: plus(2),
        seq: 2,
      }),
      buildEvent({
        type: "topic.renamed",
        data: { topicId: "topic-a", name: "Alpha 2", aliases: [] },
        device: "dev-b",
        ts: "2026-07-28T00:00:00.000Z",
        seq: 1,
      }),
    ]);
    const userWins = partitionTopics(book, {
      now: NOW,
      activeLimit: 10,
      historyDays: 30,
      sessionUpdatedAt: { [sessionKey(21)]: "2026-07-20T00:00:00.000Z" },
    });
    expect(userWins.active[0]?.lastActive).toBe("2026-07-28T00:00:00.000Z");
    const sessionWins = partitionTopics(book, {
      now: NOW,
      activeLimit: 10,
      historyDays: 30,
      sessionUpdatedAt: { [sessionKey(21)]: "2026-07-30T00:00:00.000Z" },
    });
    expect(sessionWins.active[0]?.lastActive).toBe("2026-07-30T00:00:00.000Z");
  });

  it("drops a topic from the active zone at exactly historyDays and breaks ties by topic id", () => {
    const book = foldEvents([
      created("topic-b", "B", 1),
      created("topic-a", "A", 2),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-a", sessionKey: sessionKey(31) },
        device: "dev-a",
        ts: plus(3),
        seq: 3,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-b", sessionKey: sessionKey(32) },
        device: "dev-a",
        ts: plus(4),
        seq: 4,
      }),
    ]);
    const exactly = new Date(Date.parse(NOW) - 30 * DAY).toISOString();
    const inside = new Date(Date.parse(NOW) - 30 * DAY + 1).toISOString();
    const onTheLine = partitionTopics(book, {
      now: NOW,
      activeLimit: 10,
      historyDays: 30,
      sessionUpdatedAt: {
        [sessionKey(31)]: exactly,
        [sessionKey(32)]: exactly,
      },
    });
    expect(onTheLine.active).toEqual([]);
    expect(onTheLine.history.map((topic) => topic.topicId)).toEqual(["topic-a", "topic-b"]);
    const tied = partitionTopics(book, {
      now: NOW,
      activeLimit: 1,
      historyDays: 30,
      sessionUpdatedAt: {
        [sessionKey(31)]: inside,
        [sessionKey(32)]: inside,
      },
    });
    expect(tied.active.map((topic) => topic.topicId)).toEqual(["topic-a"]);
    expect(tied.history.map((topic) => topic.topicId)).toEqual(["topic-b"]);
  });

  it("uses the refine time for a session this device never downloaded", () => {
    const refined = plus(30 * 60 * 1000);
    const book = foldEvents([
      created("topic-remote", "Remote", 1),
      buildEvent({
        type: "session.refined",
        data: {
          sessionKey: sessionKey(1),
          fileId: "file-1",
          source: "codex",
          title: "from another device",
          summary: "",
          refinedUpTo: 2,
        },
        device: "dev-b",
        ts: refined,
        seq: 1,
      }),
      buildEvent({
        type: "topic.assigned",
        data: { topicId: "topic-remote", sessionKey: sessionKey(1) },
        device: "dev-b",
        ts: plus(30 * 60 * 1000 + 1),
        seq: 2,
      }),
    ]);

    expect(deriveLastActive(book).get("topic-remote")).toBe(refined);
    expect(deriveLastActive(book, { [sessionKey(1)]: plus(60 * 60 * 1000) }).get("topic-remote")).toBe(
      plus(60 * 60 * 1000),
    );
  });
});
