import { describe, expect, test } from "bun:test";

import { filterTopics, groupSessionsByTopic, sortSessionsByTime } from "../../src/lib/group.js";

const sessions = [
  {
    sessionKey: "b",
    topicId: "design",
    topicName: "you-brain 设计",
    title: "事件日志",
    updatedAt: "2026-10-18T02:00:00.000Z",
  },
  {
    sessionKey: "a",
    topicId: "design",
    topicName: "you-brain 设计",
    title: "同步",
    updatedAt: "2026-10-18T09:00:00.000Z",
  },
  {
    sessionKey: "c",
    topicId: null,
    topicName: null,
    title: "临时脚本",
    updatedAt: "2026-10-18T01:00:00.000Z",
  },
  {
    sessionKey: "d",
    topicId: "trip",
    topicName: null,
    title: "行程",
    updatedAt: null,
  },
];

describe("groupSessionsByTopic", () => {
  test("groups by topic, names the unassigned bucket, and orders by newest session", () => {
    const groups = groupSessionsByTopic(sessions, "未归类");
    expect(groups.map((group) => group.topicName)).toEqual(["you-brain 设计", "未归类", "未归类"]);
    expect(groups[0]?.sessions.map((session) => session.sessionKey)).toEqual(["a", "b"]);
    expect(groups[1]?.topicId).toBeNull();
    expect(groups[2]?.topicId).toBe("trip");
  });
});

describe("sortSessionsByTime", () => {
  test("puts missing timestamps last and breaks ties by session key", () => {
    const sorted = sortSessionsByTime([
      { sessionKey: "b", updatedAt: "2026-10-18T01:00:00.000Z" },
      { sessionKey: "a", updatedAt: "2026-10-18T01:00:00.000Z" },
      { sessionKey: "c", updatedAt: null },
    ]);
    expect(sorted.map((session) => session.sessionKey)).toEqual(["a", "b", "c"]);
  });
});

describe("filterTopics", () => {
  const topics = [
    { name: "税务整理", summary: "发票", nextStep: "", aliases: ["报税"] },
    { name: "旅行", summary: "京都", nextStep: "订机票", aliases: [] },
  ];

  test("matches name, summary, next step, and aliases", () => {
    expect(filterTopics(topics, "报税").map((topic) => topic.name)).toEqual(["税务整理"]);
    expect(filterTopics(topics, "机票").map((topic) => topic.name)).toEqual(["旅行"]);
  });

  test("returns every topic for a blank query", () => {
    expect(filterTopics(topics, "  ")).toHaveLength(2);
  });
});
