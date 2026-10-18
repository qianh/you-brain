import { describe, expect, it } from "bun:test";
import { PROTOCOL_VERSION, isUlid, type RefineOutput } from "@you-brain/protocol";

import { LlmRequestError } from "../../src/llm/errors.js";
import type { LlmBackend } from "../../src/llm/types.js";
import { refineSession } from "../../src/refine/run.js";
import type { RefineEventFactory, RefineIdSource, RefineSessionInput } from "../../src/refine/types.js";

const SESSION = "a".repeat(64);
const STAMP = "2026-07-19T01:00:00.000Z";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function fixedUlid(n: number): string {
  let value = n;
  const chars = Array.from({ length: 16 }, () => "0");
  for (let index = 15; index >= 0; index -= 1) {
    chars[index] = ALPHABET[value % 32] ?? "0";
    value = Math.floor(value / 32);
  }
  return `${"0".repeat(10)}${chars.join("")}`;
}

function factory(): RefineEventFactory {
  let seq = 1;
  return () => ({ ts: STAMP, device: "device-1", seq: seq++ });
}

function ids(): RefineIdSource {
  let event = 1;
  let conclusion = 1;
  let todo = 1;
  return {
    eventId: () => fixedUlid(event++),
    topicId: () => "topic-created",
    conclusionId: () => `conclusion-${conclusion++}`,
    todoId: () => `todo-new-${todo++}`,
  };
}

function backend(replies: string[]): LlmBackend & { calls: number } {
  let calls = 0;
  return {
    id: "fake",
    descriptor: {
      provider: "custom",
      kind: "openai-compatible",
      model: "fake",
      baseUrl: "http://fake",
      jsonMode: "json_object",
      requiresApiKey: false,
    },
    calls,
    async complete() {
      calls += 1;
      this.calls = calls;
      const reply = replies[calls - 1];
      if (reply === undefined) throw new Error("no more replies");
      if (reply.startsWith("THROW")) {
        throw new LlmRequestError("rate_limit", "请求被限流（HTTP 429）", { status: 429 });
      }
      return reply;
    },
    async test() {},
  };
}

function input(messages = ["先定目录名", "就叫 you-brain"]): RefineSessionInput {
  return {
    sessionKey: SESSION,
    fileId: "file-1",
    source: "codex",
    refinedUpTo: 3,
    messages: messages.map((text, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text,
    })),
    previous: null,
    topics: [
      {
        topicId: "topic-1",
        name: "命名",
        aliases: ["naming"],
        summary: "目录怎么叫",
        zone: "active",
      },
    ],
    openTodos: [],
  };
}

const clean: RefineOutput = {
  title: "目录命名",
  summary: "决定使用 you-brain",
  topic: { action: "assign", topicId: "topic-1", name: "命名", aliases: [] },
  conclusions_added: ["目录名用 you-brain"],
  todos_added: [{ text: "补测试", confidence: 0.9 }],
  todos_completed: [],
};

describe("refine session", () => {
  it("turns a fixed model response into a fixed event sequence", async () => {
    const model = backend([JSON.stringify(clean)]);
    const result = await refineSession(model, input(), {
      eventFactory: factory(),
      ids: ids(),
    });
    expect(model.calls).toBe(1);
    expect(result).toEqual({
      status: "refined",
      output: {
        ...clean,
        topic: { action: "assign", topicId: "topic-1", name: "命名", aliases: ["naming"] },
      },
      events: [
        {
          v: PROTOCOL_VERSION,
          id: fixedUlid(1),
          ts: STAMP,
          device: "device-1",
          seq: 1,
          type: "session.refined",
          data: {
            sessionKey: SESSION,
            fileId: "file-1",
            source: "codex",
            title: "目录命名",
            summary: "决定使用 you-brain",
            refinedUpTo: 5,
          },
        },
        {
          v: PROTOCOL_VERSION,
          id: fixedUlid(2),
          ts: STAMP,
          device: "device-1",
          seq: 2,
          type: "topic.assigned",
          data: { topicId: "topic-1", sessionKey: SESSION },
        },
        {
          v: PROTOCOL_VERSION,
          id: fixedUlid(3),
          ts: STAMP,
          device: "device-1",
          seq: 3,
          type: "conclusion.added",
          data: {
            conclusionId: "conclusion-1",
            topicId: "topic-1",
            text: "目录名用 you-brain",
            sessionKey: SESSION,
          },
        },
        {
          v: PROTOCOL_VERSION,
          id: fixedUlid(4),
          ts: STAMP,
          device: "device-1",
          seq: 4,
          type: "todo.added",
          data: {
            todoId: "todo-new-1",
            topicId: "topic-1",
            text: "补测试",
            sessionKey: SESSION,
            confidence: 0.9,
          },
        },
      ],
    });
    expect(result.status === "refined" && result.events.every((event) => isUlid(event.id))).toBe(true);
  });

  it("corrects create, confidence, duplicate conclusions, and completed ids before emitting events", async () => {
    const raw = {
      title: "继续命名",
      summary: "沿用现有话题",
      topic: { action: "create", topicId: "", name: "  命名  ", aliases: ["新"] },
      conclusions_added: ["已有结论", "已有结论", "补了别名"],
      todos_added: [
        { text: "低置信", confidence: 0.5 },
        { text: "高置信", confidence: 0.8 },
      ],
      todos_completed: ["todo-1", "ghost", "todo-1"],
    };
    const model = backend(["```json\n" + JSON.stringify(raw) + "\n```"]);
    const result = await refineSession(
      model,
      {
        ...input(["再确认一次名字"]),
        refinedUpTo: 1,
        previous: {
          title: "旧标题",
          summary: "旧概要",
          conclusions: ["已有结论"],
          todos: [{ id: "todo-1", text: "写说明" }],
        },
        openTodos: [{ todoId: "todo-1", topicId: "topic-1", text: "写说明" }],
      },
      { eventFactory: factory(), ids: ids() },
    );
    expect(result.status).toBe("refined");
    if (result.status !== "refined") return;
    expect(result.output.topic).toEqual({
      action: "assign",
      topicId: "topic-1",
      name: "命名",
      aliases: ["naming"],
    });
    expect(result.output.conclusions_added).toEqual(["补了别名"]);
    expect(result.output.todos_added).toEqual([{ text: "高置信", confidence: 0.8 }]);
    expect(result.output.todos_completed).toEqual(["todo-1"]);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.refined",
      "topic.assigned",
      "conclusion.added",
      "todo.added",
      "todo.status_changed",
    ]);
    expect(result.events[0]?.data).toMatchObject({ refinedUpTo: 2 });
    expect(result.events[4]).toMatchObject({
      type: "todo.status_changed",
      data: { todoId: "todo-1", status: "done", by: "auto" },
    });
  });

  it("creates a topic when assign points at an unknown id", async () => {
    const model = backend([
      JSON.stringify({
        title: "新事情",
        summary: "和命名无关",
        topic: { action: "assign", topicId: "missing", name: "部署", aliases: [] },
        conclusions_added: [],
        todos_added: [],
        todos_completed: [],
      }),
    ]);
    const result = await refineSession(model, input(["怎么部署"]), {
      eventFactory: factory(),
      ids: ids(),
    });
    expect(result.status).toBe("refined");
    if (result.status !== "refined") return;
    expect(result.events.map((event) => event.type)).toEqual([
      "session.refined",
      "topic.created",
      "topic.assigned",
    ]);
    expect(result.events[1]).toMatchObject({
      type: "topic.created",
      data: { topicId: "topic-created", name: "部署", aliases: [] },
    });
    expect(result.events[2]).toMatchObject({
      type: "topic.assigned",
      data: { topicId: "topic-created", sessionKey: SESSION },
    });
  });

  it("retries a schema failure once and then returns a skip", async () => {
    const recovered = backend(["not json", JSON.stringify(clean)]);
    const recoveredResult = await refineSession(recovered, input(), {
      eventFactory: factory(),
      ids: ids(),
    });
    expect(recovered.calls).toBe(2);
    expect(recoveredResult.status).toBe("refined");

    const failed = backend(["nope", "still nope"]);
    const failedResult = await refineSession(failed, input(), {
      eventFactory: factory(),
      ids: ids(),
    });
    expect(failed.calls).toBe(2);
    expect(failedResult).toMatchObject({
      status: "skipped",
      reason: "invalid_output",
      attempts: 2,
    });
  });

  it("does not call the model when there are no new messages, and does not swallow transport errors", async () => {
    const idle = backend([]);
    const skipped = await refineSession(idle, input([]), {
      eventFactory: factory(),
      ids: ids(),
    });
    expect(idle.calls).toBe(0);
    expect(skipped).toEqual({
      status: "skipped",
      reason: "no_new_messages",
      attempts: 0,
      detail: "没有新增消息",
    });

    const failing = backend(["THROW"]);
    await expect(
      refineSession(failing, input(), { eventFactory: factory(), ids: ids() }),
    ).rejects.toMatchObject({ kind: "rate_limit" });
    expect(failing.calls).toBe(1);
  });
});
