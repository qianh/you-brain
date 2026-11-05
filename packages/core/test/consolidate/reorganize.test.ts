import { describe, expect, it } from "bun:test";
import { createEvent, type Event } from "@you-brain/protocol";

import {
  NOISE_GROUP_NAME,
  parseReorganizePlan,
  planTopicReorganization,
  reorganizeEvents,
  reorganizeTopics,
  type ReorganizeTopic,
} from "../../src/consolidate/reorganize.js";
import type { LlmBackend } from "../../src/llm/types.js";
import { foldEvents } from "../../src/topics/fold.js";
import { partitionTopics } from "../../src/topics/zones.js";

function row(topicId: string, patch: Partial<ReorganizeTopic> = {}): ReorganizeTopic {
  return {
    topicId,
    name: topicId,
    aliases: [],
    status: "active",
    userLocked: false,
    sessionCount: 1,
    createdTs: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

const KEY = "a".repeat(64);
let seq = 0;
function event(type: Event["type"], data: unknown, ts = "2026-10-01T00:00:00.000Z"): Event {
  seq += 1;
  const id = `01J${String(seq).padStart(23, "0")}`;
  return createEvent({ type, id, ts, device: "dev", seq, data } as never);
}
function created(topicId: string, name: string, ts?: string): Event {
  return event("topic.created", { topicId, name, aliases: [] }, ts);
}

describe("parseReorganizePlan", () => {
  it("makes the topic with the most sessions the survivor and counts what is left", () => {
    const topics = [row("a", { sessionCount: 1 }), row("b", { sessionCount: 5 }), row("c")];
    const plan = parseReorganizePlan(
      { groups: [{ name: "港口目录", reason: "同一个项目", topics: [0, 1] }], noise: [] },
      topics,
      3,
    );
    expect(plan.topicCountAfter).toBe(2);
    expect(plan.groups[0]?.intoTopicId).toBe("b");
    expect(plan.groups[0]?.members.map((member) => member.topicId)).toEqual(["b", "a"]);
    expect(plan.groups[0]?.name).toBe("港口目录");
  });

  it("drops unknown indexes, repeats, and groups left with a single topic", () => {
    const topics = [row("a"), row("b"), row("c")];
    const plan = parseReorganizePlan(
      {
        groups: [
          { name: "一", reason: "", topics: [0, 1, 99, 1] },
          { name: "二", reason: "", topics: [1, 2] },
        ],
        noise: [],
      },
      topics,
      3,
    );
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.name).toBe("一");
  });

  it("never merges away a topic the user touched, and keeps its name when it survives", () => {
    const topics = [
      row("mine", { userLocked: true, name: "我改过的名字", sessionCount: 1 }),
      row("big", { sessionCount: 9 }),
      row("z-also-mine", { userLocked: true }),
    ];
    const plan = parseReorganizePlan(
      { groups: [{ name: "模型起的名字", reason: "", topics: [0, 1, 2] }], noise: [] },
      topics,
      3,
    );
    const group = plan.groups[0];
    expect(group?.intoTopicId).toBe("mine");
    expect(group?.name).toBe("我改过的名字");
    expect(group?.members.map((member) => member.topicId)).toEqual(["mine", "big"]);
  });

  it("gathers noise into one archived group and leaves locked topics out", () => {
    const topics = [row("a"), row("b"), row("locked", { userLocked: true })];
    const plan = parseReorganizePlan({ groups: [], noise: [0, 1, 2] }, topics, 3);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.archive).toBe(true);
    expect(plan.groups[0]?.name).toBe(NOISE_GROUP_NAME);
    expect(plan.groups[0]?.members).toHaveLength(2);
  });

  it("treats a topic listed both ways as noise", () => {
    const topics = [row("a"), row("b"), row("c")];
    const plan = parseReorganizePlan(
      { groups: [{ name: "项目", reason: "", topics: [0, 1] }], noise: [1, 2] },
      topics,
      3,
    );
    expect(plan.groups.map((group) => group.archive)).toEqual([true]);
  });
});

describe("planTopicReorganization", () => {
  function backend(replies: string[]): LlmBackend & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      descriptor: { kind: "http", provider: "test", model: "test" },
      complete: async ({ user }: { user: string }) => {
        calls.push(user);
        return replies.shift() ?? "";
      },
    } as unknown as LlmBackend & { calls: string[] };
  }

  it("does not call the model with nothing to compare", async () => {
    const llm = backend([]);
    const plan = await planTopicReorganization(llm, [row("a")]);
    expect(plan.groups).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("retries once on unusable output and says why", async () => {
    const llm = backend(["不是 JSON", JSON.stringify({ groups: [], noise: [] })]);
    const plan = await planTopicReorganization(llm, [row("a"), row("b")]);
    expect(plan.groups).toEqual([]);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]).toContain("上次输出无法通过校验");
  });

  it("fails rather than returning an empty plan when the model never answers properly", async () => {
    const llm = backend(["坏", "还是坏"]);
    await expect(planTopicReorganization(llm, [row("a"), row("b")])).rejects.toThrow("话题整理方案生成失败");
  });

  it("is running at once on an API backend, but waits for the CLI to say its turn has come", async () => {
    const answer = JSON.stringify({ groups: [], noise: [] });
    const onRunning = (): void => {
      running += 1;
    };
    let running = 0;

    const api = { ...backend([answer]), descriptor: { kind: "openai-compatible" } } as unknown as LlmBackend;
    await planTopicReorganization(api, [row("a"), row("b")], { onRunning });
    expect(running).toBe(1);

    running = 0;
    let handed: (() => void) | undefined;
    const cli = {
      descriptor: { kind: "cli" },
      complete: async (request: { onStart?: () => void }) => {
        handed = request.onStart;
        return answer;
      },
    } as unknown as LlmBackend;
    await planTopicReorganization(cli, [row("a"), row("b")], { onRunning });
    expect(running).toBe(0);
    expect(handed).toBe(onRunning);
  });
});

describe("reorganizeEvents", () => {
  const assignedOld = (topicId: string, key: string) =>
    event("topic.assigned", { topicId, sessionKey: key });

  it("does not make merged topics look active today", () => {
    const old = "2026-01-01T00:00:00.000Z";
    const book = foldEvents([
      created("a", "港口目录接入", old),
      created("b", "港口目录复核", old),
      assignedOld("a", KEY),
    ]);
    const { events } = reorganizeEvents(book, [
      { intoTopicId: "a", fromTopicIds: ["b"], name: "港口目录", archive: false },
    ]);
    const after = foldEvents([
      ...book.memory.log,
      ...events.map((item) =>
        event(item.type, item.data, "2026-11-04T00:00:00.000Z"),
      ),
    ]);
    const survivor = after.topics.find((topic) => topic.topicId === "a");
    expect(survivor?.name).toBe("港口目录");
    expect(survivor?.lastContentAt).toBeNull();
    expect(survivor?.lastUserOpAt).toBeNull();
    const zones = partitionTopics(after, {
      now: "2026-11-04T00:00:00.000Z",
      activeLimit: 10,
      historyDays: 30,
    });
    expect(zones.active).toHaveLength(0);
    expect(after.topics.find((topic) => topic.topicId === "b")?.mergedInto).toBe("a");
  });

  it("still counts a merge the user made as activity", () => {
    const after = foldEvents([
      created("a", "甲"),
      created("b", "乙"),
      event("topic.merged", { fromTopicId: "b", intoTopicId: "a" }, "2026-11-04T00:00:00.000Z"),
    ]);
    expect(after.topics.find((topic) => topic.topicId === "a")?.lastContentAt).toBe(
      "2026-11-04T00:00:00.000Z",
    );
  });

  it("keeps the old names as aliases so later sessions still match", () => {
    const book = foldEvents([created("a", "港口目录接入"), created("b", "港口目录复核")]);
    const { events } = reorganizeEvents(book, [
      { intoTopicId: "a", fromTopicIds: ["b"], name: "港口目录", archive: false },
    ]);
    const renamed = events.find((item) => item.type === "topic.renamed");
    expect(renamed?.data).toMatchObject({ aliases: ["港口目录接入", "港口目录复核"], by: "auto" });
  });

  it("skips what changed since the plan was made", () => {
    const book = foldEvents([
      created("a", "甲"),
      created("gone", "已并走"),
      created("c", "丙"),
      created("locked", "锁定"),
      event("topic.merged", { fromTopicId: "gone", intoTopicId: "c" }),
      event("topic.status_changed", { topicId: "locked", status: "active", by: "user" }),
    ]);
    const { events, merged } = reorganizeEvents(book, [
      { intoTopicId: "a", fromTopicIds: ["gone", "locked", "missing"], name: "甲", archive: false },
    ]);
    expect(events).toEqual([]);
    expect(merged).toBe(0);
  });

  it("archives noise, and brings back an archived survivor when open work joins it", () => {
    const book = foldEvents([
      created("noise-1", "探针"),
      created("noise-2", "握手"),
      created("done", "旧项目"),
      created("open", "旧项目接入"),
      event("topic.status_changed", { topicId: "done", status: "done", by: "auto" }),
    ]);
    const { events } = reorganizeEvents(book, [
      { intoTopicId: "noise-1", fromTopicIds: ["noise-2"], name: "探针", archive: true },
      { intoTopicId: "done", fromTopicIds: ["open"], name: "旧项目", archive: false },
    ]);
    const statuses = events.filter((item) => item.type === "topic.status_changed").map((item) => item.data);
    expect(statuses).toEqual([
      { topicId: "noise-1", status: "done", by: "auto" },
      { topicId: "done", status: "active", by: "auto" },
    ]);
  });
});

describe("reorganizeTopics", () => {
  it("lists live topics with session counts, newest first", () => {
    const book = foldEvents([
      created("old", "旧", "2026-01-01T00:00:00.000Z"),
      created("new", "新", "2026-02-01T00:00:00.000Z"),
      created("merged", "并走", "2026-03-01T00:00:00.000Z"),
      event("topic.merged", { fromTopicId: "merged", intoTopicId: "old" }),
      event("topic.assigned", { topicId: "old", sessionKey: KEY }),
    ]);
    expect(reorganizeTopics(book).map((topic) => [topic.topicId, topic.sessionCount])).toEqual([
      ["new", 0],
      ["old", 1],
    ]);
  });
});
