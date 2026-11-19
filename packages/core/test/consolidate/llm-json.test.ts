import { describe, expect, it } from "bun:test";

import { completeJsonWithRetry } from "../../src/consolidate/llm-json.js";
import { LlmAbortError, LlmRequestError } from "../../src/llm/errors.js";
import { fakeBackend } from "../daemon/helpers.js";

const SCHEMA = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
};

function parseValue(input: unknown): string {
  if (!input || typeof input !== "object" || typeof (input as { value?: unknown }).value !== "string") {
    throw new Error("missing value");
  }
  return (input as { value: string }).value;
}

describe("completeJsonWithRetry", () => {
  it("fails immediately on non-retryable 404 or 401 without retrying", async () => {
    for (const err of [
      new LlmRequestError("client", "unknown model", { status: 404 }),
      new LlmRequestError("auth", "invalid key", { status: 401 }),
    ]) {
      let calls = 0;
      const llm = fakeBackend(async () => {
        calls += 1;
        throw err;
      });
      await expect(
        completeJsonWithRetry(llm, { system: "s", user: "u" }, SCHEMA, parseValue, {
          retryDelaysMs: [0, 0],
        }),
      ).rejects.toBe(err);
      expect(calls).toBe(1);
    }
  });

  it("retries transport errors with unchanged prompt user text", async () => {
    const users: string[] = [];
    const llm = fakeBackend(async (request) => {
      users.push(request.user);
      if (users.length < 3) {
        throw new LlmRequestError("network", "流式响应空闲超时");
      }
      return JSON.stringify({ value: "ok" });
    });
    const result = await completeJsonWithRetry(
      llm,
      { system: "s", user: "original-user" },
      SCHEMA,
      parseValue,
      { retryDelaysMs: [0, 0] },
    );
    expect(result).toBe("ok");
    expect(users).toEqual(["original-user", "original-user", "original-user"]);
  });

  it("retries format/schema failures once with correction feedback and separates transport budget", async () => {
    const users: string[] = [];
    let attempt = 0;
    const llm = fakeBackend(async (request) => {
      users.push(request.user);
      attempt += 1;
      if (attempt === 1) throw new LlmRequestError("server", "502", { status: 502 });
      if (attempt === 2) return JSON.stringify({ wrong: true });
      return JSON.stringify({ value: "fixed" });
    });
    const result = await completeJsonWithRetry(
      llm,
      { system: "s", user: "base" },
      SCHEMA,
      parseValue,
      { retryDelaysMs: [0, 0] },
    );
    expect(result).toBe("fixed");
    expect(users).toHaveLength(3);
    expect(users[0]).toBe("base");
    expect(users[1]).toBe("base");
    expect(users[2]).toContain("上次输出无法通过校验");
  });

  it("stops immediately when external signal aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const llm = fakeBackend(async () => {
      calls += 1;
      controller.abort();
      throw new LlmRequestError("network", "timeout");
    });
    await expect(
      completeJsonWithRetry(llm, { system: "s", user: "u" }, SCHEMA, parseValue, {
        signal: controller.signal,
        retryDelaysMs: [1_000, 2_000],
      }),
    ).rejects.toBeInstanceOf(LlmAbortError);
    expect(calls).toBe(1);
  });
});
