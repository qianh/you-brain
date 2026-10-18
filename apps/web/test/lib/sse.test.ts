import { describe, expect, test } from "bun:test";

import { drainSse } from "../../src/lib/sse.js";

describe("drainSse", () => {
  test("splits complete frames and keeps a partial tail", () => {
    const buffer = [
      "id: 1",
      "event: topics",
      'data: {"id":1,"kind":"topics"}',
      "",
      "data: second",
      "",
      "data: partial",
    ].join("\n");
    const parsed = drainSse(buffer);
    expect(parsed.frames).toEqual([
      { id: "1", event: "topics", data: '{"id":1,"kind":"topics"}' },
      { id: null, event: null, data: "second" },
    ]);
    expect(parsed.rest).toBe("data: partial");
  });

  test("accepts CRLF and skips comments", () => {
    const parsed = drainSse(": ping\r\ndata: ready\r\n\r\n");
    expect(parsed.frames).toEqual([{ id: null, event: null, data: "ready" }]);
    expect(parsed.rest).toBe("");
  });
});
