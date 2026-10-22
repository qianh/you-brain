import { describe, expect, it } from "bun:test";

import {
  EVENT_TYPES,
  conversationKey,
  createEvent,
  isUlid,
  parseEvent,
  parseEventsJsonl,
  serializeEventsJsonl,
  ulid,
  type EventType,
} from "../src/index.js";

const SESSION_KEY = conversationKey("codex", "abc");
const TS = "2026-10-18T03:00:00.000Z";

function envelope(
  type: EventType,
  data: unknown,
  seq = 1,
): Record<string, unknown> {
  return {
    v: 1,
    id: ulid(1_700_000_000_000),
    ts: TS,
    device: "device-1",
    seq,
    type,
    data,
  };
}

function validData(type: EventType): Record<string, unknown> {
  switch (type) {
    case "session.refined":
      return {
        sessionKey: SESSION_KEY,
        fileId: "file-1",
        source: "codex",
        title: "title",
        summary: "summary",
        refinedUpTo: 2,
      };
    case "topic.created":
      return { topicId: "topic-1", name: "naming", aliases: ["alias"] };
    case "topic.assigned":
      return { topicId: "topic-1", sessionKey: SESSION_KEY };
    case "topic.unassigned":
      return { topicId: "topic-1", sessionKey: SESSION_KEY };
    case "topic.renamed":
      return { topicId: "topic-1", name: "renamed", aliases: [] };
    case "topic.status_changed":
      return { topicId: "topic-1", status: "follow_up", by: "user" };
    case "topic.merged":
      return { fromTopicId: "topic-1", intoTopicId: "topic-2" };
    case "topic.summary_rewritten":
      return { topicId: "topic-1", summary: "overview", nextStep: "ship it" };
    case "conclusion.added":
      return {
        conclusionId: "conclusion-1",
        topicId: "topic-1",
        text: "decided",
        sessionKey: SESSION_KEY,
      };
    case "todo.added":
      return {
        todoId: "todo-1",
        topicId: "topic-1",
        text: "follow up",
        sessionKey: SESSION_KEY,
        confidence: 0.9,
      };
    case "todo.status_changed":
      return { todoId: "todo-1", status: "dropped", by: "auto" };
    case "portrait.correction":
      return {
        correctionId: "correction-1",
        variant: "coding",
        section: "style",
        text: "prefer short functions",
      };
    case "portrait.correction_applied":
      return { correctionId: "correction-1", snapshot: "digital-twin/snap.md" };
    case "reminder.issued":
      return {
        reminderId: "reminder-1",
        kind: "follow_up",
        topicId: "topic-1",
        text: "still open",
      };
    case "reminder.action":
      return {
        reminderId: "reminder-1",
        topicId: "topic-1",
        action: "snooze",
        until: "2026-10-19T08:00:00.000Z",
      };
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

function invalidate(type: EventType, data: Record<string, unknown>): void {
  switch (type) {
    case "session.refined":
      data.refinedUpTo = -1;
      return;
    case "topic.created":
      data.name = "";
      return;
    case "topic.assigned":
      data.sessionKey = "not-a-key";
      return;
    case "topic.unassigned":
      data.topicId = "";
      return;
    case "topic.renamed":
      data.aliases = "alias";
      return;
    case "topic.status_changed":
      data.status = "closed";
      return;
    case "topic.merged":
      data.fromTopicId = "";
      return;
    case "topic.summary_rewritten":
      delete data.nextStep;
      return;
    case "conclusion.added":
      data.text = "";
      return;
    case "todo.added":
      data.confidence = 2;
      return;
    case "todo.status_changed":
      data.status = "cancelled";
      return;
    case "portrait.correction":
      data.variant = "";
      return;
    case "portrait.correction_applied":
      data.snapshot = "";
      return;
    case "reminder.issued":
      data.kind = "";
      return;
    case "reminder.action":
      data.action = "dismiss";
      return;
    default: {
      const unreachable: never = type;
      throw new Error(unreachable);
    }
  }
}

describe("events", () => {
  it("lists all 15 event types", () => {
    expect(EVENT_TYPES).toHaveLength(15);
    expect(new Set(EVENT_TYPES).size).toBe(15);
  });

  it("parses a valid and invalid payload for every event type", () => {
    for (const type of EVENT_TYPES) {
      const valid = envelope(type, validData(type));
      const parsed = parseEvent(valid);
      expect(parsed.type).toBe(type);
      expect(parsed.v).toBe(1);

      const brokenData = validData(type);
      invalidate(type, brokenData);
      expect(() => parseEvent(envelope(type, brokenData))).toThrow();
    }
  });

  it("rejects a broken envelope", () => {
    const data = validData("session.refined");
    expect(() => parseEvent({ ...envelope("session.refined", data), v: 2 })).toThrow();
    expect(() =>
      parseEvent({ ...envelope("session.refined", data), id: "not-a-ulid" }),
    ).toThrow();
    expect(() =>
      parseEvent({ ...envelope("session.refined", data), ts: "yesterday" }),
    ).toThrow();
    expect(() => parseEvent({ ...envelope("session.refined", data), seq: -1 })).toThrow();
    expect(() => parseEvent({ ...envelope("session.refined", data), device: "" })).toThrow();
    expect(() => parseEvent({ ...envelope("session.refined", data), type: "nope" })).toThrow();
    expect(() => parseEvent("{")).toThrow();
  });

  it("accepts a reminder that is not attached to a topic", () => {
    for (const type of ["reminder.issued", "reminder.action"] as const) {
      const data = validData(type);
      data.topicId = null;
      const parsed = parseEvent(envelope(type, data));
      expect(parsed.type).toBe(type);
      if (parsed.type !== "reminder.issued" && parsed.type !== "reminder.action") {
        throw new Error("expected a reminder");
      }
      expect(parsed.data.topicId).toBeNull();
    }
    const named = validData("reminder.issued");
    named.topicId = "topic-1";
    const namedParsed = parseEvent(envelope("reminder.issued", named));
    if (namedParsed.type !== "reminder.issued") throw new Error("expected issued");
    expect(namedParsed.data.topicId).toBe("topic-1");
  });

  it("fills v and a ULID when creating an event", () => {
    const event = createEvent({
      type: "topic.created",
      data: { topicId: "topic-1", name: "naming", aliases: [] },
      device: "device-1",
      ts: TS,
      seq: 0,
    });
    expect(event.v).toBe(1);
    expect(event.seq).toBe(0);
    expect(isUlid(event.id)).toBe(true);
    expect(event.data.name).toBe("naming");
  });

  it("round-trips jsonl and reports bad lines without stopping", () => {
    const events = EVENT_TYPES.map((type, index) =>
      parseEvent(envelope(type, validData(type), index)),
    );
    const serialized = serializeEventsJsonl(events);
    expect(serialized.endsWith("\n")).toBe(true);
    const roundTrip = parseEventsJsonl(serialized);
    expect(roundTrip.errors).toEqual([]);
    expect(roundTrip.events).toEqual(events);

    const lines = serialized.trimEnd().split("\n");
    const mixed = [
      lines[0],
      "",
      "{not json",
      lines[1],
      "   ",
      JSON.stringify({ v: 1, type: "topic.created" }),
      lines[2],
    ].join("\n");
    const parsed = parseEventsJsonl(mixed);
    expect(parsed.events.map((event) => event.type)).toEqual([
      "session.refined",
      "topic.created",
      "topic.assigned",
    ]);
    expect(parsed.errors.map((error) => error.line)).toEqual([3, 6]);
    expect(parsed.errors.every((error) => error.message.length > 0)).toBe(true);
  });

  it("parses CRLF jsonl and ignores a trailing newline", () => {
    const event = parseEvent(envelope("todo.added", validData("todo.added")));
    const text = `${JSON.stringify(event)}\r\nnot-json\r\n`;
    const parsed = parseEventsJsonl(text);
    expect(parsed.events).toEqual([event]);
    expect(parsed.errors.map((error) => error.line)).toEqual([2]);
    expect(parseEventsJsonl("")).toEqual({ events: [], errors: [] });
    expect(serializeEventsJsonl([])).toBe("");
  });
});
