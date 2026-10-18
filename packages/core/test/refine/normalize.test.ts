import { describe, expect, it } from "bun:test";
import { parseRefineOutput, type RefineOutput } from "@you-brain/protocol";

import { normalizeRefineOutput, normalizeTopicName } from "../../src/refine/normalize.js";
import type { CandidateTopic } from "../../src/refine/types.js";

const topics: CandidateTopic[] = [
  {
    topicId: "topic-1",
    name: "You Brain",
    aliases: ["yb"],
    summary: "项目命名",
    zone: "active",
  },
];

function output(patch: Partial<RefineOutput> = {}): RefineOutput {
  return parseRefineOutput({
    title: "继续命名",
    summary: "沿用现有话题",
    topic: { action: "assign", topicId: "topic-1", name: "You Brain", aliases: [] },
    conclusions_added: [],
    todos_added: [],
    todos_completed: [],
    ...patch,
  });
}

describe("normalize refine output", () => {
  it("normalizes topic names by case and whitespace", () => {
    expect(normalizeTopicName("  YOU   Brain ")).toBe("you brain");
  });

  it("turns a create with an existing normalized name into assign", () => {
    let created = 0;
    const normalized = normalizeRefineOutput(
      output({
        topic: { action: "create", topicId: "", name: "  you   brain ", aliases: ["新"] },
      }),
      {
        topics,
        openTodos: [],
        previous: null,
        ids: {
          topicId: () => {
            created += 1;
            return "should-not-run";
          },
        },
      },
    );
    expect(created).toBe(0);
    expect(normalized.topic).toEqual({
      action: "assign",
      topicId: "topic-1",
      name: "You Brain",
      aliases: ["yb"],
    });
  });

  it("turns an assign of an unknown topic into create, but not when only an alias matches", () => {
    const ids = { topicId: () => "topic-new" };
    const created = normalizeRefineOutput(
      output({
        topic: { action: "assign", topicId: "missing", name: "全新事项", aliases: ["x"] },
      }),
      { topics, openTodos: [], previous: null, ids },
    );
    expect(created.topic).toEqual({
      action: "create",
      topicId: "topic-new",
      name: "全新事项",
      aliases: ["x"],
    });

    const aliasOnly = normalizeRefineOutput(
      output({
        topic: { action: "create", topicId: "", name: "yb", aliases: [] },
      }),
      { topics, openTodos: [], previous: null, ids: { topicId: () => "topic-alias" } },
    );
    expect(aliasOnly.topic.action).toBe("create");
    expect(aliasOnly.topic.topicId).toBe("topic-alias");
  });

  it("drops low-confidence todos, duplicate conclusions, and unknown completed ids", () => {
    const normalized = normalizeRefineOutput(
      output({
        conclusions_added: ["已选定仓库", "  已选定仓库  ", "补了别名"],
        todos_added: [
          { text: "低置信", confidence: 0.79 },
          { text: "高置信", confidence: 0.8 },
          { text: "   ", confidence: 0.95 },
        ],
        todos_completed: ["todo-1", "missing", "todo-1"],
      }),
      {
        topics,
        openTodos: [{ todoId: "todo-1", topicId: "topic-1", text: "写说明" }],
        previous: {
          title: "旧",
          summary: "旧",
          conclusions: ["已选定仓库"],
          todos: [],
        },
        ids: { topicId: () => "unused" },
      },
    );
    expect(normalized.conclusions_added).toEqual(["补了别名"]);
    expect(normalized.todos_added).toEqual([{ text: "高置信", confidence: 0.8 }]);
    expect(normalized.todos_completed).toEqual(["todo-1"]);
  });

  it("names a create from the title when the model leaves the name blank", () => {
    const normalized = normalizeRefineOutput(
      output({
        title: "部署脚本",
        topic: { action: "create", topicId: "nope", name: "  ", aliases: [" ", "脚本"] },
      }),
      { topics: [], openTodos: [], previous: null, ids: { topicId: () => "topic-fallback" } },
    );
    expect(normalized.topic).toEqual({
      action: "create",
      topicId: "topic-fallback",
      name: "部署脚本",
      aliases: ["脚本"],
    });
  });
});
