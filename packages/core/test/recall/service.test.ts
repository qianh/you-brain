import { describe, expect, it } from "bun:test";

import type { LlmBackend, LlmCompleteRequest } from "../../src/llm/types.js";
import {
  RECALL_CONSIDERED_CURSOR,
  RECALL_RETRY_DELAYS_MS,
  RECALL_SYSTEM_PROMPT,
  RecallService,
  recallReminderId,
  type RecallLogEntry,
  type RecallPorts,
} from "../../src/recall/index.js";
import type { CandidateTopic } from "../../src/refine/types.js";
import type { ReminderRecord } from "../../src/store/types.js";
import { OLD, recallBook } from "./fixture.js";

const START = Date.parse("2026-11-16T08:00:00.000Z");
const MIN = 60_000;
const SESSION = "claude-code:new-session";
const TOPIC = "topic-a";
const TURNS = ["海运运价预测这次改成按周重训怎么样"];
const SAY_NORMAL = JSON.stringify({ say: true, grade: "normal", text: "11-13 你说等 10 月数据到了再重训，还开着。", basisId: "todo:todo-1" });
const SAY_IMPORTANT = JSON.stringify({ say: true, grade: "important", text: "11-08 你定的是按月重训，理由是周数据噪声太大。", basisId: "conclusion:con-1" });
const SILENT = JSON.stringify({ say: false });

const topics: CandidateTopic[] = [
  { topicId: TOPIC, name: "海运运价预测", aliases: ["运价"], summary: "预测海运运价", zone: "active" },
];

type Reply = string | Error;

function setup(replies: Reply[], options: { muted?: boolean; llmMissing?: boolean; emitFails?: boolean } = {}) {
  let now = START;
  const requests: { at: number; request: LlmCompleteRequest }[] = [];
  const emitted: { reminderId: string; kind: string; topicId: string; text: string; sessionKey?: string }[] = [];
  const logs: RecallLogEntry[] = [];
  const reminders: ReminderRecord[] = [];
  const cursor = new Map<string, string>();
  const llm: LlmBackend = {
    id: "fake",
    descriptor: { provider: "claude-cli", kind: "cli", model: "fake", baseUrl: "", jsonMode: "none", requiresApiKey: false } as never,
    async complete(request) {
      requests.push({ at: now, request });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("没有预设的回复");
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async test() {},
  };
  const ports: RecallPorts = {
    llm: () => (options.llmMissing ? null : llm),
    book: () => recallBook(),
    candidateTopics: () => topics,
    sessionUpdatedAt: () => ({}),
    reminders: () => reminders,
    topicMuted: () => options.muted === true,
    async emit(data) {
      if (options.emitFails) throw new Error("写事件失败");
      emitted.push(data);
      reminders.push({ ...data, sessionKey: data.sessionKey ?? null, status: "active", until: null, issuedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
    },
    cursors: { get: (key) => cursor.get(key) ?? null, set: (key, value) => void cursor.set(key, value) },
    log: (entry) => void logs.push(entry),
    nowMs: () => now,
    timeZone: () => "Asia/Shanghai",
  };
  const service = new RecallService(ports);
  return {
    service,
    requests,
    emitted,
    logs,
    reminders,
    cursor,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("RecallService", () => {
  it("提到旧话题时发出提醒，正文原样来自模型，记录一行 issued", async () => {
    const t = setup([SAY_NORMAL]);
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    expect(t.service.pending()).toBe(1);
    await t.service.tick();
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]?.request.system).toBe(RECALL_SYSTEM_PROMPT);
    expect(t.emitted).toEqual([
      {
        reminderId: recallReminderId(SESSION, TOPIC),
        kind: "recall",
        topicId: TOPIC,
        text: "11-13 你说等 10 月数据到了再重训，还开着。",
        sessionKey: OLD,
      },
    ]);
    expect(t.logs.at(-1)).toMatchObject({ outcome: "issued", grade: "normal", kind: "recall", topicId: TOPIC });
    expect(t.service.pending()).toBe(0);
  });

  it("会话变了但没有新的用户发言时不入队", async () => {
    const t = setup([SILENT]);
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    expect(t.service.pending()).toBe(1);
    await t.service.tick();
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    expect(t.service.pending()).toBe(0);
    expect(t.requests).toHaveLength(1);
  });

  it("模型说不说 → 记为已考虑，同一会话同一话题不再调用模型", async () => {
    const t = setup([SILENT]);
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    await t.service.tick();
    expect(t.logs.at(-1)?.outcome).toBe("silent");
    expect(JSON.parse(t.cursor.get(RECALL_CONSIDERED_CURSOR) as string)).toHaveLength(1);
    t.service.consider({ sessionKey: SESSION, userTurns: [...TURNS, "海运运价预测还要加上港口拥堵"] });
    expect(t.service.pending()).toBe(0);
    expect(t.requests).toHaveLength(1);
  });

  it("模型出错 → 1、5、30 分钟各重试一次，之后放弃且未记为已考虑", async () => {
    const t = setup([new Error("超时"), new Error("超时"), new Error("超时"), new Error("超时")]);
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    const delays = [0, ...RECALL_RETRY_DELAYS_MS];
    for (let index = 0; index < delays.length; index += 1) {
      if (index > 0) {
        // 没到点不跑
        t.advance((delays[index] as number) - 1);
        await t.service.tick();
        expect(t.requests).toHaveLength(index);
        t.advance(1);
      }
      await t.service.tick();
      expect(t.requests).toHaveLength(index + 1);
    }
    expect(t.requests.map((item) => item.at - START)).toEqual([0, 1 * MIN, 6 * MIN, 36 * MIN]);
    expect(t.logs.map((item) => item.outcome)).toEqual(["failed", "failed", "failed", "gave-up"]);
    expect(t.service.pending()).toBe(0);
    expect(t.cursor.has(RECALL_CONSIDERED_CURSOR)).toBe(false);
  });

  it("放弃后同一会话有新发言会重新入队", async () => {
    const t = setup(Array.from({ length: 4 }, () => new Error("超时")));
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    for (const delay of [0, ...RECALL_RETRY_DELAYS_MS]) {
      t.advance(delay);
      await t.service.tick();
    }
    expect(t.service.pending()).toBe(0);
    t.service.consider({ sessionKey: SESSION, userTurns: [...TURNS, "海运运价预测再问一句"] });
    expect(t.service.pending()).toBe(1);
  });

  it("重试成功后照常发出，档位和结果按重试时的情况判定", async () => {
    const t = setup([new Error("超时"), SAY_IMPORTANT]);
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    await t.service.tick();
    t.advance(MIN);
    await t.service.tick();
    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0]?.kind).toBe("recall");
    expect(t.logs.map((item) => item.outcome)).toEqual(["failed", "issued"]);
  });

  it("提醒已存在时不再发第二次", async () => {
    const t = setup([SAY_NORMAL]);
    t.reminders.push({
      reminderId: recallReminderId(SESSION, TOPIC),
      kind: "recall",
      topicId: TOPIC,
      sessionKey: null,
      text: "已有",
      status: "active",
      until: null,
      issuedAt: new Date(START - MIN).toISOString(),
      updatedAt: new Date(START - MIN).toISOString(),
    });
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    await t.service.tick();
    expect(t.emitted).toHaveLength(0);
    expect(t.logs.at(-1)?.outcome).toBe("duplicate");
  });

  /** 前三次调用失败，第四次在 36 分钟时才有结果。 */
  async function runToFourthCall(t: ReturnType<typeof setup>, beforeLast?: () => void) {
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    for (const delay of RECALL_RETRY_DELAYS_MS.slice(0, 2)) {
      await t.service.tick();
      t.advance(delay);
    }
    await t.service.tick();
    t.advance(RECALL_RETRY_DELAYS_MS[2]);
    beforeLast?.();
    await t.service.tick();
  }

  it("一般档晚于 5 分钟且会话已 10 分钟没有新发言 → 发 recall_quiet", async () => {
    const t = setup([new Error("超时"), new Error("超时"), new Error("超时"), SAY_NORMAL]);
    await runToFourthCall(t);
    expect(t.emitted.map((item) => item.kind)).toEqual(["recall_quiet"]);
    expect(t.logs.at(-1)).toMatchObject({ outcome: "issued", kind: "recall_quiet", reason: "late" });
  });

  it("晚到但会话 10 分钟内还有新发言 → 一般档照常发 recall", async () => {
    const t = setup([new Error("超时"), new Error("超时"), new Error("超时"), SAY_NORMAL]);
    await runToFourthCall(t, () =>
      t.service.consider({ sessionKey: SESSION, userTurns: [...TURNS, "海运运价预测还要看港口"] }),
    );
    expect(t.emitted.map((item) => item.kind)).toEqual(["recall"]);
  });

  it("助手还在输出（没有新的用户发言）不算还在话题上 → 一般档仍发 recall_quiet", async () => {
    const t = setup([new Error("超时"), new Error("超时"), new Error("超时"), SAY_NORMAL]);
    await runToFourthCall(t, () => t.service.consider({ sessionKey: SESSION, userTurns: TURNS }));
    expect(t.emitted.map((item) => item.kind)).toEqual(["recall_quiet"]);
  });

  it("重要档在同样情况下发 recall", async () => {
    const t = setup([new Error("超时"), new Error("超时"), new Error("超时"), SAY_IMPORTANT]);
    await runToFourthCall(t);
    expect(t.emitted.map((item) => item.kind)).toEqual(["recall"]);
    expect(t.logs.at(-1)).toMatchObject({ outcome: "issued", grade: "important", kind: "recall" });
  });

  it("一般档被冷却压下时不发，记 suppressed 并记为已考虑", async () => {
    const t = setup([SAY_NORMAL]);
    t.reminders.push({
      reminderId: "recall:other",
      kind: "recall",
      topicId: TOPIC,
      sessionKey: null,
      text: "早先的",
      status: "dismissed",
      until: null,
      issuedAt: new Date(START - 2 * 60 * MIN).toISOString(),
      updatedAt: new Date(START - 2 * 60 * MIN).toISOString(),
    });
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    await t.service.tick();
    expect(t.emitted).toHaveLength(0);
    expect(t.logs.at(-1)).toMatchObject({ outcome: "suppressed", reason: "topic-cooldown", grade: "normal" });
    expect(t.cursor.has(RECALL_CONSIDERED_CURSOR)).toBe(true);
  });

  it("话题被静音时不调用模型", async () => {
    const t = setup([SAY_NORMAL], { muted: true });
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    expect(t.service.pending()).toBe(0);
    await t.service.tick();
    expect(t.requests).toHaveLength(0);
    expect(t.logs.at(-1)?.outcome).toBe("muted");
  });

  it("匹配不上话题时不调用模型", async () => {
    const t = setup([SAY_NORMAL]);
    t.service.consider({ sessionKey: SESSION, userTurns: ["今天中午吃什么"] });
    expect(t.service.pending()).toBe(0);
    expect(t.logs.at(-1)?.outcome).toBe("no-topic");
  });

  it("llm 不可用时按失败处理并重试", async () => {
    const t = setup([], { llmMissing: true });
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    await t.service.tick();
    expect(t.logs.at(-1)).toMatchObject({ outcome: "failed" });
    expect(t.service.pending()).toBe(1);
  });

  it("写事件失败按失败处理，不记为已考虑", async () => {
    const t = setup([SAY_NORMAL], { emitFails: true });
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    await t.service.tick();
    expect(t.logs.at(-1)?.outcome).toBe("failed");
    expect(t.service.pending()).toBe(1);
    expect(t.cursor.has(RECALL_CONSIDERED_CURSOR)).toBe(false);
  });

  it("模型输出不合规（超长正文）按失败重试，不截断硬发", async () => {
    const long = JSON.stringify({ say: true, grade: "normal", text: "字".repeat(61), basisId: "todo:todo-1" });
    const t = setup([long, SAY_NORMAL]);
    t.service.consider({ sessionKey: SESSION, userTurns: TURNS });
    await t.service.tick();
    expect(t.emitted).toHaveLength(0);
    t.advance(MIN);
    await t.service.tick();
    expect(t.emitted).toHaveLength(1);
  });

  it("consider 与 tick 在端口抛错时不向外抛", async () => {
    const ports: RecallPorts = {
      llm: () => { throw new Error("x"); },
      book: () => { throw new Error("x"); },
      candidateTopics: () => { throw new Error("x"); },
      sessionUpdatedAt: () => { throw new Error("x"); },
      reminders: () => { throw new Error("x"); },
      topicMuted: () => { throw new Error("x"); },
      emit: async () => { throw new Error("x"); },
      cursors: { get: () => { throw new Error("x"); }, set: () => { throw new Error("x"); } },
      log: () => { throw new Error("x"); },
      nowMs: () => START,
      timeZone: () => "Asia/Shanghai",
    };
    const service = new RecallService(ports);
    expect(() => service.consider({ sessionKey: SESSION, userTurns: TURNS })).not.toThrow();
    await expect(service.tick()).resolves.toBeUndefined();
  });
});
