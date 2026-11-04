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

  it("keeps a session on its topic whatever the model says", () => {
    const previous = { title: "旧", summary: "旧", conclusions: [], todos: [], topicId: "topic-1" };
    for (const topic of [
      { action: "create" as const, topicId: "", name: "今日A股行情", aliases: [] },
      { action: "assign" as const, topicId: "topic-2", name: "别的", aliases: [] },
      { action: "none" as const, topicId: "", name: "", aliases: [] },
    ]) {
      const normalized = normalizeRefineOutput(output({ topic }), {
        topics: [...topics, { topicId: "topic-2", name: "别的", aliases: [], summary: "", zone: "active" }],
        openTodos: [],
        previous,
        ids: { topicId: () => "should-not-run" },
      });
      expect(normalized.topic.topicId).toBe("topic-1");
      expect(normalized.topic.action).toBe("assign");
    }
  });

  it("lets a session choose again when its topic no longer exists", () => {
    const normalized = normalizeRefineOutput(
      output({ topic: { action: "create", topicId: "", name: "全新事项", aliases: [] } }),
      {
        topics,
        openTodos: [],
        previous: { title: "旧", summary: "旧", conclusions: [], todos: [], topicId: "gone" },
        ids: { topicId: () => "topic-new" },
      },
    );
    expect(normalized.topic.topicId).toBe("topic-new");
  });

  it("drops conclusions and todos for a session with nothing worth keeping", () => {
    const normalized = normalizeRefineOutput(
      output({
        topic: { action: "none", topicId: "", name: "", aliases: [] },
        conclusions_added: ["回复了 ok"],
        todos_added: [{ text: "再测一次", confidence: 0.9 }],
      }),
      { topics, openTodos: [], previous: null, ids: { topicId: () => "unused" } },
    );
    expect(normalized.topic.action).toBe("none");
    expect(normalized.conclusions_added).toEqual([]);
    expect(normalized.todos_added).toEqual([]);
  });

  it("does not open a duplicate that differs only by punctuation or a verb", () => {
    const existing: CandidateTopic[] = [
      { topicId: "port", name: "GM2 港口目录接入", aliases: [], summary: "", zone: "history" },
    ];
    for (const name of ["gm2-港口目录接入", "GM2港口目录接入评审", "GM2港口目录接入修复复核"]) {
      const normalized = normalizeRefineOutput(
        output({ topic: { action: "create", topicId: "", name, aliases: [] } }),
        { topics: existing, openTodos: [], previous: null, ids: { topicId: () => "should-not-run" } },
      );
      expect(normalized.topic).toMatchObject({ action: "assign", topicId: "port" });
    }
  });

  it("does not let two reviews of different things collapse into one", () => {
    const existing: CandidateTopic[] = [
      { topicId: "x", name: "代码审查", aliases: [], summary: "", zone: "history" },
    ];
    const normalized = normalizeRefineOutput(
      output({ topic: { action: "create", topicId: "", name: "合同审查", aliases: [] } }),
      { topics: existing, openTodos: [], previous: null, ids: { topicId: () => "topic-new" } },
    );
    expect(normalized.topic.action).toBe("create");
  });
});
