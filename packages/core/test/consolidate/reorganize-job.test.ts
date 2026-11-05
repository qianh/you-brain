import { describe, expect, it } from "bun:test";

import { ReorganizeJob } from "../../src/consolidate/reorganize-job.js";
import type { ReorganizePlan } from "../../src/consolidate/reorganize.js";

const NOW = "2026-11-04T10:00:00.000Z";
const PLAN: ReorganizePlan = { topicCount: 2, reviewedCount: 2, topicCountAfter: 2, groups: [] };

interface Pending {
  promise: Promise<ReorganizePlan>;
  resolve: (plan: ReorganizePlan) => void;
  reject: (error: Error) => void;
}

function pending(): Pending {
  let resolve: Pending["resolve"] = () => undefined;
  let reject: Pending["reject"] = () => undefined;
  const promise = new Promise<ReorganizePlan>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("ReorganizeJob", () => {
  it("is idle until started and reports queued, running, then ready", async () => {
    const job = new ReorganizeJob({ now: () => NOW });
    expect(job.status()).toEqual({ state: "idle" });

    const work = pending();
    let onRunning = (): void => undefined;
    const started = job.start((running) => {
      onRunning = running;
      return work.promise;
    });
    expect(started).toEqual({ state: "queued", startedAt: NOW });

    onRunning();
    expect(job.status()).toEqual({ state: "running", startedAt: NOW });

    work.resolve(PLAN);
    await tick();
    expect(job.status()).toEqual({ state: "ready", plan: PLAN });
  });

  it("does not stack a second model call behind a run in progress, even on refresh", () => {
    const job = new ReorganizeJob({ now: () => NOW });
    let calls = 0;
    const work = (): Promise<ReorganizePlan> => {
      calls += 1;
      return pending().promise;
    };
    job.start(work);
    job.start(work);
    job.start(work, { refresh: true });
    expect(calls).toBe(1);
  });

  it("keeps a ready plan unless asked to refresh", async () => {
    const job = new ReorganizeJob({ now: () => NOW });
    let calls = 0;
    const work = async (): Promise<ReorganizePlan> => {
      calls += 1;
      return PLAN;
    };
    job.start(work);
    await tick();
    expect(job.start(work)).toEqual({ state: "ready", plan: PLAN });
    expect(calls).toBe(1);

    expect(job.start(work, { refresh: true }).state).toBe("queued");
    expect(calls).toBe(2);
  });

  it("keeps the failure reason, and the next start runs again", async () => {
    const job = new ReorganizeJob({ now: () => NOW });
    job.start(async () => {
      throw new Error("模型额度用完了");
    });
    await tick();
    expect(job.status()).toEqual({ state: "failed", message: "模型额度用完了" });

    job.start(async () => PLAN);
    await tick();
    expect(job.status()).toEqual({ state: "ready", plan: PLAN });
  });

  it("reports a failure instead of waiting forever when the work never settles", async () => {
    const job = new ReorganizeJob({ now: () => NOW, deadlineMs: 5 });
    job.start(() => pending().promise);
    await tick(30);
    const status = job.status();
    expect(status.state).toBe("failed");
    if (status.state === "failed") expect(status.message).toContain("分钟");
  });

  it("still takes a plan that arrives just after the deadline", async () => {
    const job = new ReorganizeJob({ now: () => NOW, deadlineMs: 5 });
    const work = pending();
    job.start(() => work.promise);
    await tick(30);
    expect(job.status().state).toBe("failed");
    work.resolve(PLAN);
    await tick();
    expect(job.status()).toEqual({ state: "ready", plan: PLAN });
  });

  it("ignores a late result once a newer run has started", async () => {
    const job = new ReorganizeJob({ now: () => NOW, deadlineMs: 5 });
    const first = pending();
    job.start(() => first.promise);
    await tick(30);

    const second = pending();
    job.start(() => second.promise);
    first.resolve({ ...PLAN, topicCount: 99 });
    await tick();
    expect(job.status().state).toBe("queued");

    second.resolve(PLAN);
    await tick();
    expect(job.status()).toEqual({ state: "ready", plan: PLAN });
  });

  it("clear forgets the plan and drops any run in progress", async () => {
    const job = new ReorganizeJob({ now: () => NOW });
    const work = pending();
    job.start(() => work.promise);
    job.clear();
    expect(job.status()).toEqual({ state: "idle" });
    work.resolve(PLAN);
    await tick();
    expect(job.status()).toEqual({ state: "idle" });
  });

  it("turns work that throws synchronously into a failure", () => {
    const job = new ReorganizeJob({ now: () => NOW });
    const status = job.start(() => {
      throw new Error("读不到话题");
    });
    expect(status).toEqual({ state: "failed", message: "读不到话题" });
  });
});
