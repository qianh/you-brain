import { describe, expect, it } from "bun:test";

import { fitRefineMessages, selectCandidateTopics, selectOpenTodos } from "../../src/refine/messages.js";
import { buildRefinePrompt } from "../../src/refine/prompt.js";
import type { CandidateTopic } from "../../src/refine/types.js";

function topic(id: string, zone: "active" | "history", recency?: number): CandidateTopic {
  return {
    topicId: id,
    name: id,
    aliases: [],
    summary: `${id} 概要`,
    zone,
    ...(recency === undefined ? {} : { recency }),
  };
}

describe("refine prompt input", () => {
  it("states the assignment rules in Chinese", () => {
    const prompt = buildRefinePrompt({
      previous: {
        title: "旧标题",
        summary: "旧概要",
        conclusions: ["已经决定用 bun"],
        todos: [{ id: "old", text: "旧待办" }],
      },
      topics: [
        {
          topicId: "topic-1",
          name: "命名",
          aliases: ["naming"],
          summary: "目录怎么叫",
          zone: "active",
        },
      ],
      openTodos: [{ todoId: "todo-1", topicId: "topic-1", text: "补测试" }],
      messages: [{ role: "user", text: "叫 you-brain" }],
      truncated: false,
    });
    expect(prompt.system).toContain("优先归入已有话题");
    expect(prompt.system).toContain("明显是一件新事情");
    expect(prompt.system).toContain("0.8");
    expect(prompt.system).toContain("一个会话只归入一个主话题");
    expect(prompt.system).toContain("todoId");
    expect(prompt.user).toContain("旧标题");
    expect(prompt.user).toContain("已经决定用 bun");
    expect(prompt.user).toContain("topic-1");
    expect(prompt.user).toContain("命名");
    expect(prompt.user).toContain("naming");
    expect(prompt.user).toContain("目录怎么叫");
    expect(prompt.user).toContain("todo-1");
    expect(prompt.user).toContain("叫 you-brain");
    expect(prompt.user).not.toContain("更早的新增消息已因长度截断");
  });

  it("drops the earliest new messages once the character budget is exceeded", () => {
    const messages = [
      { role: "user", text: "甲".repeat(50) },
      { role: "assistant", text: "乙".repeat(50) },
      { role: "user", text: "丙".repeat(20) },
    ];
    const fitted = fitRefineMessages(messages, 40);
    expect(fitted.truncated).toBe(true);
    expect(fitted.messages.map((message) => message.text[0])).toEqual(["丙"]);
    const prompt = buildRefinePrompt({
      previous: null,
      topics: [],
      openTodos: [],
      messages: fitted.messages,
      truncated: fitted.truncated,
    });
    expect(prompt.user).toContain("更早的新增消息已因长度截断");
    expect(prompt.user).toContain("丙");
    expect(prompt.user).not.toContain("甲");
    expect(prompt.user).toContain("首次提炼");
  });

  it("keeps every active topic and the 20 most recent history topics", () => {
    const history = Array.from({ length: 25 }, (_, index) => topic(`h${index}`, "history"));
    const selected = selectCandidateTopics(
      [topic("a1", "active"), topic("a2", "active"), ...history],
      20,
    );
    expect(selected.map((item) => item.topicId)).toEqual([
      "a1",
      "a2",
      ...Array.from({ length: 20 }, (_, index) => `h${index + 5}`),
    ]);

    const dated = selectCandidateTopics(
      [
        topic("old-end", "history", 1),
        topic("new", "history", 50),
        topic("mid", "history", 10),
      ],
      2,
    );
    expect(dated.map((item) => item.topicId)).toEqual(["new", "mid"]);
  });

  it("keeps the tail of one oversized message", () => {
    const fitted = fitRefineMessages([{ role: "user", text: "0123456789" }], 10);
    expect(fitted.truncated).toBe(true);
    expect(fitted.messages).toEqual([{ role: "user", text: "789" }]);
  });

  it("can drop the history zone without dropping active topics", () => {
    const selected = selectCandidateTopics([topic("keep", "active"), topic("old", "history")], 0);
    expect(selected.map((item) => item.topicId)).toEqual(["keep"]);
    expect(
      selectOpenTodos(
        [
          { todoId: "todo-keep", topicId: "keep", text: "留下" },
          { todoId: "todo-old", topicId: "old", text: "不属于候选" },
        ],
        selected,
      ).map((todo) => todo.todoId),
    ).toEqual(["todo-keep"]);
  });
});
