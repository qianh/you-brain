import { describe, expect, it } from "bun:test";

import { topicStem } from "../../src/topics/normalize.js";
import {
  rankTopicsByText,
  recentSessionTitles,
  topicTerms,
} from "../../src/topics/similarity.js";

function topic(topicId: string, name: string, recentTitles: string[] = []) {
  return { topicId, name, aliases: [], recentTitles };
}

describe("topic similarity", () => {
  it("splits Chinese into pairs and keeps ASCII words whole", () => {
    expect(topicTerms("GM2港口目录")).toEqual(["gm2", "港口", "口目", "目录"]);
  });

  it("finds the topic a session belongs to among unrelated ones", () => {
    const ranked = rankTopicsByText(
      [topic("a", "拔罐后犯困"), topic("b", "GM2港口目录接入"), topic("c", "今日A股行情")],
      "GM2港口目录修复复核",
    );
    expect(ranked[0]?.topic.topicId).toBe("b");
    expect(ranked.map((item) => item.topic.topicId)).not.toContain("a");
  });

  it("lets a rare term outweigh one every topic has", () => {
    const ranked = rankTopicsByText(
      [
        topic("a", "Claude 登录"),
        topic("b", "Claude 配额"),
        topic("c", "Claude 模型"),
        topic("d", "Neo4j 安装"),
      ],
      "Claude 和 Neo4j",
    );
    expect(ranked[0]?.topic.topicId).toBe("d");
  });

  it("uses session titles when a topic name says little", () => {
    const ranked = rankTopicsByText(
      [topic("a", "杂项", ["Redis Lua脚本复制"]), topic("b", "杂事")],
      "Redis Lua 脚本",
    );
    expect(ranked.map((item) => item.topic.topicId)).toEqual(["a"]);
  });

  it("returns nothing for text that shares no term", () => {
    expect(rankTopicsByText([topic("a", "拔罐后犯困")], "hello world")).toEqual([]);
  });

  it("keeps the latest distinct titles per topic", () => {
    const titles = recentSessionTitles([
      { topicId: "a", title: "一", refinedAt: "2026-01-01T00:00:00.000Z" },
      { topicId: "a", title: "二", refinedAt: "2026-01-02T00:00:00.000Z" },
      { topicId: "a", title: "二", refinedAt: "2026-01-03T00:00:00.000Z" },
      { topicId: "a", title: "三", refinedAt: "2026-01-04T00:00:00.000Z" },
      { topicId: "a", title: "四", refinedAt: "2026-01-05T00:00:00.000Z" },
      { topicId: null, title: "无", refinedAt: "2026-01-06T00:00:00.000Z" },
    ]);
    expect(titles.get("a")).toEqual(["四", "三", "二"]);
    expect(titles.size).toBe(1);
  });
});

describe("topicStem", () => {
  it("drops the verb for this round of work", () => {
    expect(topicStem("GM2港口目录接入评审")).toBe(topicStem("GM2港口目录接入"));
    expect(topicStem("暗号记忆回读测试")).toBe(topicStem("暗号记忆回读"));
    expect(topicStem("支付网关修复复核")).toBe(topicStem("支付网关"));
  });

  it("refuses when too little is left to tell topics apart", () => {
    expect(topicStem("代码审查")).toBeNull();
    expect(topicStem("合同审查")).toBeNull();
  });
});
