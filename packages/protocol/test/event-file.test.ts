import { describe, expect, it } from "bun:test";

import {
  createEvent,
  parseEventLine,
  parseEventsJsonl,
  serializeEventLine,
} from "../src/index.js";

const TS = "2026-10-18T03:00:00.000Z";

function event() {
  return createEvent({
    type: "topic.created",
    data: { topicId: "topic-1", name: "命名", aliases: [] },
    device: "device-1",
    ts: TS,
    seq: 1,
    id: "01J00000000000000000000000",
  });
}

describe("event files", () => {
  it("serializes one JSON line with a trailing newline", () => {
    const line = serializeEventLine(event());
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    const parsed = parseEventLine(line);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.event).toEqual(event());
  });

  it("reports an empty line, bad JSON, and an invalid event", () => {
    expect(parseEventLine("")).toEqual({ ok: false, error: "empty line" });
    expect(parseEventLine("  \r")).toEqual({ ok: false, error: "empty line" });
    const broken = parseEventLine("{not json");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.error.length).toBeGreaterThan(0);
    const invalid = parseEventLine(JSON.stringify({ v: 1, type: "topic.created" }));
    expect(invalid.ok).toBe(false);
  });

  it("keeps file parsing aligned with single-line parsing", () => {
    const line = serializeEventLine(event()).trimEnd();
    const text = ["", line, "{no", "   "].join("\n");
    const parsed = parseEventsJsonl(text);
    expect(parsed.events).toEqual([event()]);
    expect(parsed.errors.map((error) => error.line)).toEqual([3]);
  });
});
