import type { Event, EventOf, EventType } from "@you-brain/protocol";

import { foldEvents } from "../../src/topics/fold.js";
import type { TopicBook } from "../../src/topics/types.js";
import { buildEvent, sessionKey } from "../topics/helpers.js";

export const SHANGHAI = "Asia/Shanghai";
export const PITCAIRN = "Pacific/Pitcairn";
export const ZONE = { activeLimit: 10, historyDays: 30 };

/** 10:00 in Asia/Shanghai on that calendar day. */
export const DAY_BEFORE = "2026-10-22T02:00:00.000Z";
export const DAY_OF = "2026-10-23T02:00:00.000Z";
export const LATER = "2026-10-23T06:00:00.000Z";
export const LOCAL_DAY = "2026-10-23";

let seq = 1;

export function ev<T extends EventType>(
  type: T,
  data: EventOf<T>["data"],
  ts: string,
): EventOf<T> {
  const event = buildEvent({
    type,
    data,
    device: "dev-a",
    ts,
    seq,
  });
  seq += 1;
  return event;
}

export function key(n: number): string {
  return sessionKey(80 + n);
}

export function fold(events: readonly Event[]): TopicBook {
  return foldEvents(events);
}

export function created(topicId: string, name: string, ts: string, aliases: string[] = []): Event {
  return ev("topic.created", { topicId, name, aliases }, ts);
}

export function assigned(topicId: string, session: string, ts: string): Event {
  return ev("topic.assigned", { topicId, sessionKey: session }, ts);
}

export function refined(session: string, title: string, summary: string, ts: string): Event {
  return ev(
    "session.refined",
    {
      sessionKey: session,
      fileId: "file-1",
      source: "claude-code",
      title,
      summary,
      refinedUpTo: 1,
    },
    ts,
  );
}
