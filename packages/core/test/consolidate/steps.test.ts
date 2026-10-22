import type { Event } from "@you-brain/protocol";
import { afterEach, describe, expect, it } from "bun:test";

import {
  MERGE_SUGGESTIONS_CURSOR,
  TOPIC_SUMMARY_JSON_SCHEMA,
  consolidationSteps,
  mergeSuggestionsStep,
  normalizeMergePairs,
  parseTopicRewrite,
  registerConsolidationStep,
  resetConsolidationSteps,
  runConsolidation,
  topicSummariesStep,
  type ConsolidationStep,
} from "../../src/consolidate/index.js";
import type { LlmCompleteRequest } from "../../src/llm/types.js";
import { SqliteStore } from "../../src/store/sqlite-store.js";
import { weeklyText } from "../../src/reminders/text.js";
import { mergeSuggestionLines } from "../../src/consolidate/suggestions.js";
import { fakeBackend } from "../daemon/helpers.js";
import {
  DAY_BEFORE,
  DAY_OF,
  LATER,
  LOCAL_DAY,
  SHANGHAI,
  ZONE,
  assigned,
  created,
  ev,
  fold,
  key,
  refined,
} from "./fixture.js";

afterEach(() => {
  resetConsolidationSteps();
});

function topic(id: string, name: string, session: string, aliases: string[] = []): Event[] {
  return [
    created(id, name, DAY_BEFORE, aliases),
    refined(session, `${name}的标题`, "会话概要", DAY_BEFORE),
    assigned(id, session, DAY_BEFORE),
  ];
}

function conclusion(id: string, topicId: string, session: string, text = "当天结论"): Event {
  return ev(
    "conclusion.added",
    { conclusionId: id, topicId, text, sessionKey: session },
    DAY_OF,
  );
}

async function settle(options: {
  events: Event[];
  complete: (request: LlmCompleteRequest) => string | Promise<string>;
  steps?: readonly ConsolidationStep[];
  updated?: Record<string, string>;
  day?: string;
  timeZone?: string;
  now?: string;
  zone?: { activeLimit: number; historyDays: number };
  cursors?: { get(key: string): string | null; set(key: string, value: string): void };
}) {
  const events = [...options.events];
  const requests: LlmCompleteRequest[] = [];
  const cursors = options.cursors ?? memCursor();
  const result = await runConsolidation({
    day: options.day ?? LOCAL_DAY,
    timeZone: options.timeZone ?? SHANGHAI,
    now: () => new Date(options.now ?? LATER),
    load: () => ({ book: fold(events), sessionUpdatedAt: options.updated ?? {} }),
    zone: options.zone ?? ZONE,
    llm: fakeBackend(async (request) => {
      requests.push(request);
      return options.complete(request);
    }),
    emit: async (type, data) => {
      events.push(ev(type, data, options.now ?? LATER));
    },
    cursors,
    steps: options.steps ?? [topicSummariesStep],
  });
  return { result, events, requests, cursors };
}

function memCursor(): { get(key: string): string | null; set(key: string, value: string): void } {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

function rewritten(events: readonly Event[], topicId: string): string[] {
  return events
    .filter((event) => event.type === "topic.summary_rewritten" && event.data.topicId === topicId)
    .map((event) => (event.type === "topic.summary_rewritten" ? event.data.summary : ""));
}

describe("topic summary rewrite", () => {
  it("rewrites a topic that changed today and sends the recent context", async () => {
    const session = key(1);
    const { result, events, requests } = await settle({
      events: [
        ...topic("alpha", "甲", session, ["别名"]),
        conclusion("c1", "alpha", session, "当天结论"),
        ev(
          "todo.added",
          {
            todoId: "open-1",
            topicId: "alpha",
            text: "还开着",
            sessionKey: session,
            confidence: 0.9,
          },
          DAY_BEFORE,
        ),
        ev(
          "todo.added",
          {
            todoId: "done-1",
            topicId: "alpha",
            text: "已完成的",
            sessionKey: session,
            confidence: 0.9,
          },
          DAY_BEFORE,
        ),
        ev("todo.status_changed", { todoId: "done-1", status: "done", by: "auto" }, DAY_BEFORE),
      ],
      complete: () => JSON.stringify({ summary: "新的话题概要", nextStep: "下一步" }),
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.system).toContain("话题概要");
    expect(requests[0]?.jsonSchema).toEqual(TOPIC_SUMMARY_JSON_SCHEMA);
    expect(requests[0]?.user).toContain("当天结论");
    expect(requests[0]?.user).toContain("还开着");
    expect(requests[0]?.user).toContain("别名");
    expect(requests[0]?.user).not.toContain("已完成的");
    expect(rewritten(events, "alpha")).toEqual(["新的话题概要"]);
    expect(fold(events).topics.find((item) => item.topicId === "alpha")).toMatchObject({
      summary: "新的话题概要",
      nextStep: "下一步",
    });
  });

  it("does not emit when the normalized summary and next step are unchanged", async () => {
    const session = key(2);
    const events = [
      ...topic("alpha", "甲", session),
      ev(
        "topic.summary_rewritten",
        { topicId: "alpha", summary: "ＡＢＣ", nextStep: "旧下一步" },
        "2026-10-23T00:30:00.000Z",
      ),
      conclusion("c1", "alpha", session),
    ];
    const same = await settle({
      events,
      complete: () => JSON.stringify({ summary: " ABC ", nextStep: " 旧下一步 " }),
    });
    expect(same.requests).toHaveLength(1);
    expect(same.result.ok).toBe(true);
    expect(rewritten(same.events, "alpha")).toEqual(["ＡＢＣ"]);

    const changedCase = await settle({
      events,
      complete: () => JSON.stringify({ summary: "abc", nextStep: "旧下一步" }),
    });
    expect(rewritten(changedCase.events, "alpha")).toEqual(["ＡＢＣ", "abc"]);
  });

  it("skips a user-locked topic", async () => {
    const session = key(3);
    const { requests, result } = await settle({
      events: [
        ...topic("alpha", "甲", session),
        ev("topic.status_changed", { topicId: "alpha", status: "follow_up", by: "user" }, DAY_BEFORE),
        conclusion("c1", "alpha", session),
      ],
      complete: () => {
        throw new Error("should not be called");
      },
    });
    expect(requests).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("keeps a successful topic when another topic fails, and skips it on retry", async () => {
    const sessionA = key(4);
    const sessionB = key(5);
    const events = [
      ...topic("alpha", "甲", sessionA),
      ...topic("beta", "乙", sessionB),
      conclusion("c-a", "alpha", sessionA),
      conclusion("c-b", "beta", sessionB),
    ];
    let phase: "first" | "second" = "first";
    const first = await settle({
      events,
      complete: (request) => {
        if (request.user.includes("话题：乙")) {
          if (phase === "first") return "not-json";
          return JSON.stringify({ summary: "乙的新概要", nextStep: "" });
        }
        return JSON.stringify({ summary: "甲的新概要", nextStep: "继续" });
      },
    });
    expect(first.result.ok).toBe(false);
    expect(first.result.steps[0]).toMatchObject({ id: "topic_summaries", error: "部分话题概要没有写完" });
    expect(first.result.warnings.some((warning) => warning.includes("话题 beta 概要重写失败"))).toBe(
      true,
    );
    expect(rewritten(first.events, "alpha")).toEqual(["甲的新概要"]);
    expect(rewritten(first.events, "beta")).toEqual([]);
    const betaCalls = first.requests.filter((request) => request.user.includes("话题：乙"));
    expect(betaCalls).toHaveLength(2);
    expect(betaCalls[1]?.user).toContain("上次输出无法通过校验");

    phase = "second";
    const second = await settle({
      events: first.events,
      complete: (request) => {
        if (request.user.includes("话题：甲")) throw new Error("甲不应再调用");
        return JSON.stringify({ summary: "乙的新概要", nextStep: "" });
      },
    });
    expect(second.requests.every((request) => request.user.includes("话题：乙"))).toBe(true);
    expect(second.requests).toHaveLength(1);
    expect(second.result.ok).toBe(true);
    expect(rewritten(second.events, "beta")).toEqual(["乙的新概要"]);
  });

  it("retries once on illegal JSON or an over-long field", async () => {
    const session = key(6);
    const base = [...topic("alpha", "甲", session), conclusion("c1", "alpha", session)];
    let attempt = 0;
    const recovered = await settle({
      events: base,
      complete: () => {
        attempt += 1;
        if (attempt === 1) return JSON.stringify({ summary: "概".repeat(201), nextStep: "步".repeat(81) });
        return JSON.stringify({ summary: "修好了", nextStep: "" });
      },
    });
    expect(recovered.requests).toHaveLength(2);
    expect(recovered.result.ok).toBe(true);
    expect(rewritten(recovered.events, "alpha")).toEqual(["修好了"]);

    const fenced = await settle({
      events: base,
      complete: () => `\`\`\`json\n${JSON.stringify({ summary: "围栏里的概要", nextStep: "" })}\n\`\`\``,
    });
    expect(rewritten(fenced.events, "alpha")).toEqual(["围栏里的概要"]);

    const failed = await settle({
      events: base,
      complete: () => JSON.stringify({ summary: "   ", nextStep: "" }),
    });
    expect(failed.requests).toHaveLength(2);
    expect(failed.result.ok).toBe(false);
    expect(rewritten(failed.events, "alpha")).toEqual([]);
  });

  it("rewrites at most two topics at a time", async () => {
    const events: Event[] = [];
    for (const [id, name, n] of [
      ["a", "甲", 7],
      ["b", "乙", 8],
      ["c", "丙", 9],
    ] as const) {
      const session = key(n);
      events.push(...topic(id, name, session), conclusion(`c-${id}`, id, session));
    }
    let current = 0;
    let max = 0;
    const { result } = await settle({
      events,
      complete: async (request) => {
        current += 1;
        max = Math.max(max, current);
        await new Promise((resolve) => setTimeout(resolve, 30));
        current -= 1;
        const name = /话题：(.+)/u.exec(request.user)?.[1] ?? "话题";
        return JSON.stringify({ summary: `${name}已重写`, nextStep: "" });
      },
    });
    expect(max).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.steps[0]?.ok).toBe(true);
  });
});

describe("merge suggestions", () => {
  it("drops illegal pairs, caps at five, and stores the rest", async () => {
    const store = new SqliteStore(":memory:");
    try {
      const ids = ["a", "b", "c", "d", "e"] as const;
      const events: Event[] = [];
      ids.forEach((id, index) => {
        const session = key(30 + index);
        events.push(...topic(id, `话题${id}`, session));
      });
      const updated: Record<string, string> = {};
      ids.forEach((id, index) => {
        updated[key(30 + index)] = DAY_OF;
      });
      const pairs = [
        { fromTopicId: "missing", intoTopicId: "a", reason: "不存在" },
        { fromTopicId: "a", intoTopicId: "a", reason: "自环" },
        { fromTopicId: "a", intoTopicId: "b", reason: "第一" },
        { fromTopicId: "a", intoTopicId: "b", reason: "重复" },
        { fromTopicId: "b", intoTopicId: "a", reason: "反向" },
        { fromTopicId: "a", intoTopicId: "c", reason: "   " },
        { fromTopicId: "a", intoTopicId: "c", reason: "超".repeat(81) },
        { fromTopicId: "a", intoTopicId: "c", reason: "第二" },
        { fromTopicId: "b", intoTopicId: "c", reason: "第三" },
        { fromTopicId: "c", intoTopicId: "d", reason: "第四" },
        { fromTopicId: "d", intoTopicId: "e", reason: "第五" },
        { fromTopicId: "e", intoTopicId: "b", reason: "第六" },
      ];
      const { result, requests } = await settle({
        events,
        updated,
        steps: [mergeSuggestionsStep],
        cursors: {
          get: (key) => store.getCursor(key),
          set: (key, value) => {
            store.setCursor(key, value);
          },
        },
        complete: (request) => {
          expect(request.system).toContain("合并建议");
          return JSON.stringify({ pairs });
        },
      });
      expect(requests).toHaveLength(1);
      expect(result.ok).toBe(true);
      expect(JSON.parse(store.getCursor(MERGE_SUGGESTIONS_CURSOR) ?? "")).toEqual({
        day: LOCAL_DAY,
        pairs: [
          { fromTopicId: "a", intoTopicId: "b", reason: "第一" },
          { fromTopicId: "a", intoTopicId: "c", reason: "第二" },
          { fromTopicId: "b", intoTopicId: "c", reason: "第三" },
          { fromTopicId: "c", intoTopicId: "d", reason: "第四" },
          { fromTopicId: "d", intoTopicId: "e", reason: "第五" },
        ],
      });
    } finally {
      store.close();
    }
  });

  it("retries a bad merge payload once and does not store it", async () => {
    const sessionA = key(40);
    const sessionB = key(41);
    const cursors = memCursor();
    const { result, requests } = await settle({
      events: [...topic("a", "甲", sessionA), ...topic("b", "乙", sessionB)],
      updated: { [sessionA]: DAY_OF, [sessionB]: DAY_OF },
      steps: [mergeSuggestionsStep],
      cursors,
      complete: () => "not-json",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.user).toContain("上次输出无法通过校验");
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.error).toBe("合并建议没有写完");
    expect(cursors.get(MERGE_SUGGESTIONS_CURSOR)).toBeNull();
  });

  it("stores an empty list without calling the model when fewer than two topics are visible", async () => {
    const cursors = memCursor();
    const { requests, result } = await settle({
      events: topic("a", "甲", key(42)),
      steps: [mergeSuggestionsStep],
      cursors,
      complete: () => {
        throw new Error("should not be called");
      },
    });
    expect(requests).toEqual([]);
    expect(result.ok).toBe(true);
    expect(JSON.parse(cursors.get(MERGE_SUGGESTIONS_CURSOR) ?? "")).toEqual({
      day: LOCAL_DAY,
      pairs: [],
    });
  });

  it("still stores merge suggestions when a topic rewrite fails", async () => {
    const sessionA = key(43);
    const sessionB = key(44);
    const cursors = memCursor();
    const { result, events } = await settle({
      events: [
        ...topic("a", "甲", sessionA),
        ...topic("b", "乙", sessionB),
        conclusion("c-a", "a", sessionA),
        conclusion("c-b", "b", sessionB),
      ],
      steps: consolidationSteps(),
      cursors,
      complete: (request) => {
        if (request.system.includes("话题概要")) return "not-json";
        return JSON.stringify({
          pairs: [{ fromTopicId: "a", intoTopicId: "b", reason: "同一件事" }],
        });
      },
    });
    expect(result.ok).toBe(false);
    expect(result.steps.map((step) => step.id)).toEqual([
      "topic_summaries",
      "merge_suggestions",
      "portrait",
      "topic_files",
    ]);
    expect(result.steps[1]?.ok).toBe(true);
    expect(result.steps[2]).toEqual({ id: "portrait", ok: false, error: "依赖步骤失败" });
    expect(result.steps[3]).toEqual({ id: "topic_files", ok: false, error: "依赖步骤失败" });
    expect(rewritten(events, "a")).toEqual([]);
    expect(JSON.parse(cursors.get(MERGE_SUGGESTIONS_CURSOR) ?? "").pairs).toEqual([
      { fromTopicId: "a", intoTopicId: "b", reason: "同一件事" },
    ]);
  });
});

describe("step runner", () => {
  it("skips a step whose dependency failed and still runs the others", async () => {
    let dependent = false;
    let independent = false;
    const { result } = await settle({
      events: [],
      steps: [
        {
          id: "upstream",
          run: async () => {
            throw new Error("上游失败");
          },
        },
        {
          id: "blocked",
          dependsOn: ["upstream"],
          run: async () => {
            dependent = true;
          },
        },
        {
          id: "free",
          run: async () => {
            independent = true;
          },
        },
      ],
      complete: () => "{}",
    });
    expect(dependent).toBe(false);
    expect(independent).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.steps[1]).toEqual({ id: "blocked", ok: false, error: "依赖步骤失败" });
  });

  it("clips a long step error to 80 characters", async () => {
    const { result } = await settle({
      events: [],
      steps: [
        {
          id: "long",
          run: async () => {
            throw new Error("错".repeat(100));
          },
        },
      ],
      complete: () => "{}",
    });
    expect(Array.from(result.steps[0]?.error ?? "")).toHaveLength(80);
    expect(result.steps[0]?.error?.endsWith("…")).toBe(true);
  });

  it("starts with the built-in steps and appends a registered step", async () => {
    let ran = false;
    registerConsolidationStep({
      id: "extra_step",
      async run() {
        ran = true;
      },
    });
    registerConsolidationStep({
      id: "extra_step",
      async run() {
        throw new Error("duplicate");
      },
    });
    expect(consolidationSteps().map((step) => step.id)).toEqual([
      "topic_summaries",
      "merge_suggestions",
      "portrait",
      "topic_files",
      "extra_step",
    ]);
    const { result } = await settle({
      events: [],
      steps: consolidationSteps(),
      complete: () => JSON.stringify({ pairs: [] }),
    });
    expect(ran).toBe(true);
    expect(result.ok).toBe(true);
    resetConsolidationSteps();
    expect(consolidationSteps().map((step) => step.id)).toEqual([
      "topic_summaries",
      "merge_suggestions",
      "portrait",
      "topic_files",
    ]);
  });
});

describe("normalize", () => {
  it("rejects an empty or over-long rewrite and accepts an empty next step", () => {
    expect(parseTopicRewrite({ summary: "  好的  ", nextStep: "" })).toEqual({
      summary: "好的",
      nextStep: "",
    });
    expect(() => parseTopicRewrite({ summary: "   ", nextStep: "" })).toThrow("概要为空");
    expect(() => parseTopicRewrite({ summary: "概".repeat(201), nextStep: "" })).toThrow(
      "概要超过 200 字",
    );
    expect(Array.from(parseTopicRewrite({ summary: "😀".repeat(200), nextStep: "" }).summary)).toHaveLength(
      200,
    );
    expect(() => parseTopicRewrite({ summary: "😀".repeat(201), nextStep: "" })).toThrow(
      "概要超过 200 字",
    );
  });

  it("filters merge pairs the same way the step does", () => {
    expect(
      normalizeMergePairs(
        {
          pairs: [
            { fromTopicId: "a", intoTopicId: "a", reason: "自环" },
            { fromTopicId: "nope", intoTopicId: "a", reason: "非法" },
            { fromTopicId: "a", intoTopicId: "b", reason: "可以" },
          ],
        },
        new Set(["a", "b"]),
      ),
    ).toEqual([{ fromTopicId: "a", intoTopicId: "b", reason: "可以" }]);
  });
});

describe("weekly copy", () => {
  it("lists resolved suggestions and omits the line when there are none", () => {
    const lines = mergeSuggestionLines(
      {
        day: LOCAL_DAY,
        pairs: [
          { fromTopicId: "a", intoTopicId: "b", reason: "重复" },
          { fromTopicId: "gone", intoTopicId: "b", reason: "没了" },
        ],
      },
      [
        { topicId: "a", name: "甲" },
        { topicId: "b", name: "乙" },
      ],
    );
    expect(lines).toEqual([{ fromName: "甲", intoName: "乙", reason: "重复" }]);
    const withLines = weeklyText({
      activeCount: 1,
      conclusionCount: 0,
      staleNames: [],
      historyNames: [],
      mergeSuggestions: lines,
    });
    expect(withLines).toContain("甲 与 乙 看起来是同一件事（重复）。");
    const without = weeklyText({
      activeCount: 1,
      conclusionCount: 0,
      staleNames: [],
      historyNames: [],
    });
    expect(without).not.toContain("看起来是同一件事");
    expect(without).not.toContain("相似话题");
  });
});
