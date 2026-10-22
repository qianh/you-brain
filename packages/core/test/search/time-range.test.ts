import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { YouBrainError } from "../../src/domain/errors.js";
import { errorResponse } from "../../src/http/handlers.js";
import { SearchService } from "../../src/search/search-service.js";
import {
  assertSearchRange,
  parseSearchRange,
  updatedAtInRange,
} from "../../src/search/time-range.js";
import { MemoryDrive } from "./memory-drive.js";

const DAY = 86_400_000;

function markdown(conversationId: string, updatedAt: string): Uint8Array {
  return new TextEncoder().encode(`---
source: codex
conversation_id: ${conversationId}
started_at: 2026-10-01T00:00:00.000Z
updated_at: ${updatedAt}
content_sha256: ${conversationId.padEnd(64, "0").slice(0, 64)}
---
## User
canary ${conversationId}
`);
}

describe("search time bounds", () => {
  test("reads a date-only from as UTC midnight and a date-only to as the end of that UTC day", () => {
    const start = Date.UTC(2026, 9, 22);
    const range = parseSearchRange({ since: "2026-10-22", until: "2026-10-22" });
    expect(range).toEqual({ sinceMs: start, untilMs: start + DAY - 1 });
    expect(parseSearchRange({ since: "2024-02-29" }).sinceMs).toBe(Date.UTC(2024, 1, 29));
  });

  test("compares zoned instants, Z, and truncated fractional seconds", () => {
    const utcMidnight = Date.parse("2026-10-22T00:00:00.000Z");
    expect(parseSearchRange({ since: "2026-10-22T08:00:00+08:00" }).sinceMs).toBe(utcMidnight);
    expect(parseSearchRange({ since: "2026-10-22T00:00:00Z" }).sinceMs).toBe(utcMidnight);
    expect(parseSearchRange({ since: "2026-10-22T00:00:00+00:00" }).sinceMs).toBe(utcMidnight);
    expect(parseSearchRange({ since: "2026-10-22T00:00:00.1Z" }).sinceMs).toBe(Date.parse("2026-10-22T00:00:00.100Z"));
    expect(parseSearchRange({ since: "2026-10-22T00:00:00.123456789Z" }).sinceMs).toBe(
      Date.parse("2026-10-22T00:00:00.123Z"),
    );
    const sameInstant = Date.parse("2026-10-21T16:00:00.000Z");
    expect(parseSearchRange({ since: "2026-10-22T00:00:00+08:00" }).sinceMs).toBe(sameInstant);
  });

  test("rejects invalid values as 400 and treats an empty bound as absent", () => {
    for (const value of ["2026-02-31", "2023-02-29", "2026-10-22T00:00:00", "2026-10-22T24:00:00Z", "10/22/2026", "nope", " 2026-10-22", "2026-10-22 "]) {
      let caught: unknown;
      try {
        parseSearchRange({ since: value });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(YouBrainError);
      expect(errorResponse(caught).status).toBe(400);
    }
    expect(() => assertSearchRange({ from: "", to: "" })).not.toThrow();
    expect(() => assertSearchRange({ from: "2026-10-23", to: "2026-10-22" })).not.toThrow();
    expect(() => assertSearchRange({ from: "   " })).toThrow(YouBrainError);
  });

  test("drops an unparseable stored timestamp only when a bound is set", () => {
    expect(updatedAtInRange("not-a-timestamp", parseSearchRange({}))).toBe(true);
    expect(updatedAtInRange("not-a-timestamp", parseSearchRange({ since: "2026-10-22" }))).toBe(false);
  });

  test("filters indexed rows by timestamp, including the whole date-only day and equal zoned instants", async () => {
    const drive = new MemoryDrive();
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["before-from", "2026-10-21T23:59:59.999Z"],
      ["start", "2026-10-22T00:00:00.000Z"],
      ["start-plus8", "2026-10-22T08:00:00+08:00"],
      ["end", "2026-10-22T23:59:59.999Z"],
      ["end-plus8", "2026-10-23T07:59:59.999+08:00"],
      ["next-day", "2026-10-23T00:00:00.000Z"],
      ["next-day-plus8", "2026-10-23T08:00:00+08:00"],
      ["equal-instant", "2026-10-21T16:00:00.000Z"],
      ["before-equal", "2026-10-21T15:59:59.999Z"],
      ["garbage", "not-a-timestamp"],
    ];
    for (const [id, updatedAt] of rows) {
      await drive.put({
        path: `inbox/${id}.md`,
        bytes: markdown(id, updatedAt),
        mimeType: "text/markdown",
      });
    }
    const service = new SearchService({
      drive,
      embedder: null,
      database: new Database(":memory:"),
      semantic: false,
    });
    await service.search({ query: "canary", limit: 20 });

    const day = await service.search({ query: "canary", limit: 20, since: "2026-10-22", until: "2026-10-22" });
    expect(day.results.map((result) => result.conversationId).sort()).toEqual([
      "end",
      "end-plus8",
      "start",
      "start-plus8",
    ]);

    const zoned = await service.search({ query: "canary", limit: 20, since: "2026-10-22T00:00:00+08:00" });
    const zonedIds = zoned.results.map((result) => result.conversationId);
    expect(zonedIds).toContain("equal-instant");
    expect(zonedIds).not.toContain("before-equal");

    const reversed = await service.search({ query: "canary", limit: 20, since: "2026-10-23", until: "2026-10-22" });
    expect(reversed.results).toEqual([]);

    await expect(service.query({ query: "canary", limit: 5, since: "2026-02-31" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});
