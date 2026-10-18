import { describe, expect, it } from "bun:test";

import { parseRefineOutput, type RefineOutput } from "../src/index.js";

const output: RefineOutput = {
  title: "命名方案",
  summary: "选定了目录名",
  topic: { action: "assign", topicId: "topic-1", name: "命名", aliases: ["naming"] },
  conclusions_added: ["目录用 you-brain"],
  todos_added: [{ text: "补测试", confidence: 0.9 }],
  todos_completed: ["todo-1"],
};

describe("refine output", () => {
  it("parses the model JSON from the spec", () => {
    expect(parseRefineOutput(output)).toEqual(output);
    expect(parseRefineOutput(JSON.stringify(output))).toEqual(output);
    expect(
      parseRefineOutput({
        ...output,
        topic: { action: "create", topicId: "", name: "新话题", aliases: [] },
        conclusions_added: [],
        todos_added: [],
        todos_completed: [],
      }).topic.action,
    ).toBe("create");
  });

  it("rejects a missing field, a bad action, and an out-of-range confidence", () => {
    const { summary: _summary, ...missing } = output;
    expect(() => parseRefineOutput(missing)).toThrow();
    expect(() =>
      parseRefineOutput({
        ...output,
        topic: { ...output.topic, action: "merge" },
      }),
    ).toThrow();
    expect(() =>
      parseRefineOutput({
        ...output,
        todos_added: [{ text: "补测试", confidence: 1.2 }],
      }),
    ).toThrow();
  });
});
