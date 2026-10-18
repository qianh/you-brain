import { describe, expect, it } from "bun:test";

import { LlmRequestError } from "../../src/llm/errors.js";
import { LlmRetryQueue, retryDelayMs } from "../../src/llm/retry-queue.js";

describe("llm retry queue", () => {
  it("backs off exponentially and caps the delay", () => {
    expect(retryDelayMs(1, { baseDelayMs: 1_000, factor: 2, maxDelayMs: 8_000 })).toBe(1_000);
    expect(retryDelayMs(2, { baseDelayMs: 1_000, factor: 2, maxDelayMs: 8_000 })).toBe(2_000);
    expect(retryDelayMs(3, { baseDelayMs: 1_000, factor: 2, maxDelayMs: 8_000 })).toBe(4_000);
    expect(retryDelayMs(4, { baseDelayMs: 1_000, factor: 2, maxDelayMs: 8_000 })).toBe(8_000);
    expect(retryDelayMs(8, { baseDelayMs: 1_000, factor: 2, maxDelayMs: 8_000 })).toBe(8_000);
  });

  it("records the failure reason for the status page and retries on the injected clock", () => {
    let now = 1_000;
    const queue = new LlmRetryQueue<string>({
      clock: { now: () => now },
      baseDelayMs: 1_000,
      factor: 2,
      maxDelayMs: 8_000,
    });
    queue.fail(
      "session-a",
      "payload-a",
      new LlmRequestError("rate_limit", "请求被限流（HTTP 429）：slow down", { status: 429 }),
    );
    queue.fail(
      "session-b",
      "payload-b",
      new LlmRequestError("auth", "鉴权失败（HTTP 401）", { status: 401 }),
    );
    expect(queue.due()).toEqual([]);
    expect(queue.pending()).toEqual([
      {
        id: "session-a",
        reason: "请求被限流（HTTP 429）：slow down",
        kind: "rate_limit",
        retryable: true,
        attempts: 1,
        failedAt: 1_000,
        nextAttemptAt: 2_000,
        exhausted: false,
      },
      {
        id: "session-b",
        reason: "鉴权失败（HTTP 401）",
        kind: "auth",
        retryable: false,
        attempts: 1,
        failedAt: 1_000,
        nextAttemptAt: 2_000,
        exhausted: true,
      },
    ]);

    now = 2_000;
    expect(queue.due().map((job) => job.id)).toEqual(["session-a"]);
    queue.fail("session-a", "payload-a2", new Error("网络错误：reset"));
    expect(queue.get("session-a")).toMatchObject({
      attempts: 2,
      reason: "网络错误：reset",
      kind: "unknown",
      payload: "payload-a2",
      nextAttemptAt: 4_000,
      exhausted: false,
    });

    now = 4_000;
    expect(queue.due().map((job) => job.payload)).toEqual(["payload-a2"]);
    queue.succeed("session-a");
    expect(queue.pending().map((item) => item.id)).toEqual(["session-b"]);
    expect(queue.due()).toEqual([]);
  });

  it("stops scheduling after maxAttempts but keeps the reason", () => {
    let now = 0;
    const queue = new LlmRetryQueue<number>({
      clock: { now: () => now },
      baseDelayMs: 10,
      maxAttempts: 2,
    });
    queue.fail("job", 1, new LlmRequestError("server", "模型服务错误（HTTP 500）", { status: 500 }));
    now = 10;
    expect(queue.due()).toHaveLength(1);
    queue.fail("job", 1, new LlmRequestError("server", "模型服务错误（HTTP 503）", { status: 503 }));
    now = 10_000;
    expect(queue.due()).toEqual([]);
    expect(queue.pending()[0]).toMatchObject({
      reason: "模型服务错误（HTTP 503）",
      attempts: 2,
      exhausted: true,
      retryable: false,
    });
  });
});
