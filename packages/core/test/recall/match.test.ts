import { describe, expect, it } from "bun:test";

import { matchRecallTopic } from "../../src/recall/index.js";
import type { CandidateTopic } from "../../src/refine/types.js";
import { recallBook } from "./fixture.js";

const topics: CandidateTopic[] = [
  { topicId: "topic-a", name: "海运运价预测", aliases: ["运价"], summary: "预测海运运价", zone: "active" },
  { topicId: "topic-c", name: "Agent Reach", aliases: [], summary: "接入外部信息源", zone: "active" },
];

describe("matchRecallTopic", () => {
  const book = recallBook();

  it("会话已有话题时直接用，并跟随合并", () => {
    expect(matchRecallTopic({ assignedTopicId: "topic-b", userText: "无关", topics, book })).toBe("topic-a");
    expect(matchRecallTopic({ assignedTopicId: "topic-c", userText: "无关", topics, book })).toBe("topic-c");
  });

  it("没有话题时按文本匹配", () => {
    expect(
      matchRecallTopic({ assignedTopicId: null, userText: "海运运价预测这次改成按周重训", topics, book }),
    ).toBe("topic-a");
  });

  it("分数不够或完全无关时返回 null", () => {
    expect(matchRecallTopic({ assignedTopicId: null, userText: "今天中午吃什么", topics, book })).toBeNull();
    expect(matchRecallTopic({ assignedTopicId: null, userText: "", topics, book })).toBeNull();
  });

  it("只有零星重合（分数低于阈值）也不算匹配", () => {
    // 与「Agent Reach」的概要只共享「接入」，实测分数约 0.2。
    expect(matchRecallTopic({ assignedTopicId: null, userText: "帮我看看这个接口怎么接入", topics, book })).toBeNull();
  });
});
