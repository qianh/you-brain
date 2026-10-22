import { describe, expect, test } from "bun:test";

import { withSessionCounts } from "../../src/daemon/topic-session-count.js";

describe("topic list session counts", () => {
  test("counts sessions onto every topic and leaves the input alone", () => {
    const topics = [
      { topicId: "a", name: "甲" },
      { topicId: "b", name: "乙" },
    ];
    const sessions = [{ topicId: "a" }, { topicId: "a" }, { topicId: null }, { topicId: "" }, { topicId: "gone" }];
    expect(withSessionCounts(topics, sessions)).toEqual([
      { topicId: "a", name: "甲", sessionCount: 2 },
      { topicId: "b", name: "乙", sessionCount: 0 },
    ]);
    expect(topics).toEqual([
      { topicId: "a", name: "甲" },
      { topicId: "b", name: "乙" },
    ]);
  });
});
