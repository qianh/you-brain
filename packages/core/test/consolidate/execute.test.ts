import { describe, expect, it } from "bun:test";

import {
  BACKOFF_INITIAL_MS,
  ConsolidationRejected,
  consolidationRejectMessage,
  emptyConsolidationState,
  executeConsolidation,
  type ConsolidationRuntime,
  type ConsolidationState,
} from "../../src/consolidate/index.js";
import type { ConsolidateLease } from "../../src/consolidate/lease.js";
import { fakeBackend } from "../daemon/helpers.js";
import { SHANGHAI } from "./fixture.js";

const TODAY = "2026-10-23T02:00:00.000Z";

function clockFrom(start: string) {
  let nowMs = Date.parse(start);
  return {
    now: () => new Date(nowMs),
    nowMs: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function runtime(
  clock: ReturnType<typeof clockFrom>,
  patch: Partial<ConsolidationRuntime> = {},
): ConsolidationRuntime {
  return {
    deviceId: "device-a",
    mainDevice: "device-a",
    enabled: true,
    time: "03:00",
    timeZone: SHANGHAI,
    hasLlm: true,
    hasDrive: true,
    llm: fakeBackend(async () => "{}"),
    activeLimit: 10,
    historyDays: 30,
    clock,
    load: () => ({
      book: {
        topics: [],
        sessions: [],
        conclusions: [],
        todos: [],
        memory: {
          topics: new Map(),
          sessions: new Map(),
          conclusions: new Map(),
          todos: new Map(),
          parent: new Map(),
          liveByName: new Map(),
          ids: new Set(),
          log: [],
          last: null,
        },
      },
      sessionUpdatedAt: {},
    }),
    emit: async () => undefined,
    cursors: { get: () => null, set: () => undefined },
    readLease: async () => null,
    writeLease: async () => undefined,
    steps: [{ id: "ok", async run() {} }],
    ...patch,
  };
}

describe("executeConsolidation", () => {
  it("skips a scheduled run that is not the main device, disabled, or missing a model or drive", async () => {
    const clock = clockFrom(TODAY);
    const state = emptyConsolidationState();
    const ran: string[] = [];
    const base = runtime(clock, {
      steps: [
        {
          id: "marker",
          async run() {
            ran.push("yes");
          },
        },
      ],
    });
    for (const patch of [
      { mainDevice: null },
      { mainDevice: "other" },
      { enabled: false },
      { hasLlm: false, llm: null },
      { hasDrive: false },
    ]) {
      const outcome = await executeConsolidation(runtime(clock, { ...base, ...patch }), state, {
        manual: false,
        force: false,
      });
      expect(outcome.status).toBe("skipped");
    }
    expect(ran).toEqual([]);
    expect(state.lastRun).toBeNull();
  });

  it("rejects a manual run with a stable reason", async () => {
    const clock = clockFrom(TODAY);
    const state = emptyConsolidationState();
    const rejected = await executeConsolidation(
      runtime(clock, { mainDevice: null }),
      state,
      { manual: true, force: false },
    );
    expect(rejected).toEqual({ status: "rejected", code: "NOT_MAIN_DEVICE" });
    expect(consolidationRejectMessage("DISABLED")).toBe("全局沉淀未启用");
    expect(consolidationRejectMessage("NO_LLM")).toBe("模型不可用");
    expect(consolidationRejectMessage("NO_DRIVE")).toBe("Drive 未打开");
    expect(new ConsolidationRejected("NO_LLM").code).toBe("NO_LLM");
  });

  it("does not run before the local time, then runs today", async () => {
    const clock = clockFrom(TODAY);
    const state = emptyConsolidationState();
    const days: string[] = [];
    const leases: ConsolidateLease[] = [];
    const input = runtime(clock, {
      time: "23:00",
      steps: [
        {
          id: "day",
          async run(ctx) {
            days.push(ctx.day);
          },
        },
      ],
      writeLease: async (lease) => {
        leases.push(lease);
      },
    });
    const early = await executeConsolidation(input, state, { manual: false, force: false });
    expect(early).toMatchObject({ status: "skipped", reason: "not_due" });
    expect(leases).toEqual([]);

    const due = await executeConsolidation(runtime(clock, { ...input, time: "03:00" }), state, {
      manual: false,
      force: false,
    });
    expect(due).toMatchObject({ status: "done", attempted: true });
    expect(days).toEqual(["2026-10-23"]);
    expect(leases.map((lease) => lease.date)).toEqual(["2026-10-23"]);
    expect(state.lastRun).toMatchObject({ day: "2026-10-23", ok: true });
  });

  it("processes catch-up days in order, writes each success, and stops on the first failure", async () => {
    const clock = clockFrom(TODAY);
    const state = emptyConsolidationState();
    let lease: ConsolidateLease | null = {
      date: "2026-10-16",
      deviceId: "device-a",
      finishedAt: "2026-10-16T03:00:00.000Z",
    };
    const days: string[] = [];
    let failedOnce = false;
    const outcome = await executeConsolidation(
      runtime(clock, {
        readLease: async () => lease,
        writeLease: async (next) => {
          lease = next;
        },
        steps: [
          {
            id: "day",
            async run(ctx) {
              days.push(ctx.day);
              if (ctx.day === "2026-10-18" && !failedOnce) {
                failedOnce = true;
                throw new Error("停在这一天");
              }
            },
          },
        ],
      }),
      state,
      { manual: false, force: false },
    );
    expect(days).toEqual(["2026-10-17", "2026-10-18"]);
    expect(lease?.date).toBe("2026-10-17");
    expect(outcome).toMatchObject({
      status: "done",
      attempted: true,
      result: { ok: false, day: "2026-10-18" },
    });
    expect(state.backoffMs).toBe(BACKOFF_INITIAL_MS);
    expect(state.lastRun?.error).toBe("停在这一天");

    const tooSoon = await executeConsolidation(
      runtime(clock, {
        readLease: async () => lease,
        steps: [
          {
            id: "day",
            async run() {
              days.push("early");
            },
          },
        ],
      }),
      state,
      { manual: false, force: false },
    );
    expect(tooSoon).toMatchObject({ status: "skipped", reason: "backoff" });

    clock.advance(BACKOFF_INITIAL_MS);
    const again = await executeConsolidation(
      runtime(clock, {
        readLease: async () => lease,
        writeLease: async (next) => {
          lease = next;
        },
        steps: [
          {
            id: "day",
            async run(ctx) {
              days.push(ctx.day);
            },
          },
        ],
      }),
      state,
      { manual: false, force: false },
    );
    expect(again).toMatchObject({ status: "done", attempted: true, result: { ok: true } });
    expect(days.slice(2)).toEqual([
      "2026-10-18",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
    ]);
    expect(lease?.date).toBe("2026-10-23");
    expect(state.backoffMs).toBe(0);
    expect(state.retryAtMs).toBeNull();
  });

  it("processes only today when there is no lease, even if older days exist", async () => {
    const clock = clockFrom(TODAY);
    const days: string[] = [];
    const outcome = await executeConsolidation(
      runtime(clock, {
        steps: [
          {
            id: "day",
            async run(ctx) {
              days.push(ctx.day);
            },
          },
        ],
      }),
      emptyConsolidationState(),
      { manual: false, force: false },
    );
    expect(outcome.status).toBe("done");
    expect(days).toEqual(["2026-10-23"]);
  });

  it("skips when another device already consolidated today, unless forced", async () => {
    const clock = clockFrom(TODAY);
    const state = emptyConsolidationState();
    let lease: ConsolidateLease | null = {
      date: "2026-10-23",
      deviceId: "device-b",
      finishedAt: "2026-10-23T01:00:00.000Z",
    };
    const days: string[] = [];
    const input = runtime(clock, {
      readLease: async () => lease,
      writeLease: async (next) => {
        lease = next;
      },
      steps: [
        {
          id: "day",
          async run(ctx) {
            days.push(ctx.day);
          },
        },
      ],
    });
    const skipped = await executeConsolidation(input, state, { manual: false, force: false });
    expect(skipped).toMatchObject({
      status: "done",
      attempted: false,
      result: { day: "2026-10-23", ok: true, steps: [] },
    });
    expect(days).toEqual([]);
    expect(lease?.deviceId).toBe("device-b");

    clock.advance(60_000);
    const forced = await executeConsolidation(input, state, { manual: true, force: true });
    expect(forced).toMatchObject({ status: "done", attempted: true, result: { ok: true } });
    expect(days).toEqual(["2026-10-23"]);
    expect(lease).toMatchObject({ date: "2026-10-23", deviceId: "device-a" });
  });

  it("lets a manual run ignore the backoff", async () => {
    const clock = clockFrom(TODAY);
    const state = emptyConsolidationState();
    let failed = false;
    const input = runtime(clock, {
      steps: [
        {
          id: "once",
          async run() {
            if (!failed) {
              failed = true;
              throw new Error("先失败");
            }
          },
        },
      ],
    });
    const first = await executeConsolidation(input, state, { manual: false, force: false });
    expect(first).toMatchObject({ status: "done", attempted: true, result: { ok: false } });
    const manual = await executeConsolidation(input, state, { manual: true, force: false });
    expect(manual).toMatchObject({ status: "done", attempted: true, result: { ok: true } });
    expect(state.retryAtMs).toBeNull();
  });

  it("does not advance the lease when the record cannot be written", async () => {
    const clock = clockFrom(TODAY);
    const state = emptyConsolidationState();
    let emitted = 0;
    const outcome = await executeConsolidation(
      runtime(clock, {
        emit: async () => {
          emitted += 1;
        },
        steps: [
          {
            id: "emit",
            async run(ctx) {
              await ctx.emit("topic.summary_rewritten", {
                topicId: "alpha",
                summary: "留下了",
                nextStep: "",
              });
            },
          },
        ],
        writeLease: async () => {
          throw new Error("drive down");
        },
      }),
      state,
      { manual: false, force: false },
    );
    expect(emitted).toBe(1);
    expect(outcome).toMatchObject({
      status: "done",
      attempted: true,
      result: { ok: false },
    });
    if (outcome.status === "done") {
      expect(outcome.result.warnings).toContain("沉淀记录没有写上");
    }
    expect(state.lastRun?.error).toBe("沉淀记录没有写上");
  });

  it("fails closed on an invalid time zone", async () => {
    const clock = clockFrom(TODAY);
    const state = emptyConsolidationState();
    const scheduled = await executeConsolidation(
      runtime(clock, { timeZone: "Not/AZone" }),
      state,
      { manual: false, force: false },
    );
    expect(scheduled).toMatchObject({ status: "skipped", reason: "timezone" });
    await expect(
      executeConsolidation(runtime(clock, { timeZone: "Not/AZone" }), state, {
        manual: true,
        force: false,
      }),
    ).rejects.toThrow("时区无效");
  });
});
