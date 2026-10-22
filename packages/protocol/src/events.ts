import { z } from "zod";

import { IsoTimestampSchema } from "./formats.js";
import { SessionKeySchema } from "./session.js";
import {
  EventActorSchema,
  ReminderActionSchema,
  TopicStatusSchema,
  TodoStatusSchema,
} from "./status.js";
import { ulid, UlidSchema } from "./ulid.js";
import { PROTOCOL_VERSION } from "./version.js";

const IdSchema = z.string().min(1);

export const SessionRefinedDataSchema = z.object({
  sessionKey: SessionKeySchema,
  fileId: IdSchema,
  source: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  refinedUpTo: z.int().nonnegative(),
});

export const TopicCreatedDataSchema = z.object({
  topicId: IdSchema,
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
});

export const TopicAssignedDataSchema = z.object({
  topicId: IdSchema,
  sessionKey: SessionKeySchema,
});

export const TopicUnassignedDataSchema = TopicAssignedDataSchema;

export const TopicRenamedDataSchema = z.object({
  topicId: IdSchema,
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
});

export const TopicStatusChangedDataSchema = z.object({
  topicId: IdSchema,
  status: TopicStatusSchema,
  by: EventActorSchema,
});

export const TopicMergedDataSchema = z.object({
  fromTopicId: IdSchema,
  intoTopicId: IdSchema,
});

export const TopicSummaryRewrittenDataSchema = z.object({
  topicId: IdSchema,
  summary: z.string(),
  nextStep: z.string(),
});

export const ConclusionAddedDataSchema = z.object({
  conclusionId: IdSchema,
  topicId: IdSchema,
  text: z.string().min(1),
  sessionKey: SessionKeySchema,
});

export const TodoAddedDataSchema = z.object({
  todoId: IdSchema,
  topicId: IdSchema,
  text: z.string().min(1),
  sessionKey: SessionKeySchema,
  confidence: z.number().min(0).max(1),
});

export const TodoStatusChangedDataSchema = z.object({
  todoId: IdSchema,
  status: TodoStatusSchema,
  by: EventActorSchema,
});

export const PortraitCorrectionDataSchema = z.object({
  correctionId: IdSchema,
  variant: z.string().min(1),
  section: z.string().min(1),
  text: z.string().min(1),
});

export const PortraitCorrectionAppliedDataSchema = z.object({
  correctionId: IdSchema,
  snapshot: z.string().min(1),
});

export const ReminderIssuedDataSchema = z.object({
  reminderId: IdSchema,
  kind: z.string().min(1),
  topicId: IdSchema.nullable(),
  text: z.string().min(1),
});

export const ReminderActionDataSchema = z.object({
  reminderId: IdSchema,
  topicId: IdSchema.nullable(),
  action: ReminderActionSchema,
  until: IsoTimestampSchema.nullable(),
});

function eventSchema<const T extends string, D extends z.ZodType>(
  type: T,
  data: D,
) {
  return z.object({
    v: z.literal(PROTOCOL_VERSION),
    id: UlidSchema,
    ts: IsoTimestampSchema,
    device: IdSchema,
    seq: z.int().nonnegative(),
    type: z.literal(type),
    data,
  });
}

export const EventSchema = z.discriminatedUnion("type", [
  eventSchema("session.refined", SessionRefinedDataSchema),
  eventSchema("topic.created", TopicCreatedDataSchema),
  eventSchema("topic.assigned", TopicAssignedDataSchema),
  eventSchema("topic.unassigned", TopicUnassignedDataSchema),
  eventSchema("topic.renamed", TopicRenamedDataSchema),
  eventSchema("topic.status_changed", TopicStatusChangedDataSchema),
  eventSchema("topic.merged", TopicMergedDataSchema),
  eventSchema("topic.summary_rewritten", TopicSummaryRewrittenDataSchema),
  eventSchema("conclusion.added", ConclusionAddedDataSchema),
  eventSchema("todo.added", TodoAddedDataSchema),
  eventSchema("todo.status_changed", TodoStatusChangedDataSchema),
  eventSchema("portrait.correction", PortraitCorrectionDataSchema),
  eventSchema("portrait.correction_applied", PortraitCorrectionAppliedDataSchema),
  eventSchema("reminder.issued", ReminderIssuedDataSchema),
  eventSchema("reminder.action", ReminderActionDataSchema),
]);

export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

export const EVENT_TYPES = [
  "session.refined",
  "topic.created",
  "topic.assigned",
  "topic.unassigned",
  "topic.renamed",
  "topic.status_changed",
  "topic.merged",
  "topic.summary_rewritten",
  "conclusion.added",
  "todo.added",
  "todo.status_changed",
  "portrait.correction",
  "portrait.correction_applied",
  "reminder.issued",
  "reminder.action",
] as const satisfies readonly EventType[];

type ListedEvent = (typeof EVENT_TYPES)[number];
type EventsCovered = Exclude<EventType, ListedEvent> extends never
  ? Exclude<ListedEvent, EventType> extends never
    ? true
    : never
  : never;
const EVENTS_COVERED: EventsCovered = true;
void EVENTS_COVERED;

export function parseEvent(input: unknown): Event {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  return EventSchema.parse(value);
}

export function createEvent<T extends EventType>(input: {
  type: T;
  data: EventOf<T>["data"];
  device: string;
  ts: string;
  seq: number;
  id?: string;
}): EventOf<T> {
  return parseEvent({
    v: PROTOCOL_VERSION,
    id: input.id ?? ulid(),
    ts: input.ts,
    device: input.device,
    seq: input.seq,
    type: input.type,
    data: input.data,
  }) as EventOf<T>;
}

export interface JsonlParseError {
  line: number;
  message: string;
}

export interface JsonlParseResult {
  events: Event[];
  errors: JsonlParseError[];
}

export function serializeEventsJsonl(events: readonly Event[]): string {
  if (events.length === 0) return "";
  return `${events.map((event) => JSON.stringify(parseEvent(event))).join("\n")}\n`;
}

export function parseEventsJsonl(text: string): JsonlParseResult {
  const events: Event[] = [];
  const errors: JsonlParseError[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      errors.push({
        line: lineNumber,
        message: error instanceof Error ? error.message : "Invalid JSON",
      });
      continue;
    }
    const result = EventSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({ line: lineNumber, message: result.error.message });
      continue;
    }
    events.push(result.data);
  }
  return { events, errors };
}
