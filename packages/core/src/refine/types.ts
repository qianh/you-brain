import type { Event, RefineOutput } from "@you-brain/protocol";

export interface RefineMessage {
  role: string;
  text: string;
}

export interface PreviousRefineTodo {
  id: string;
  text: string;
}

/** Last accepted refine result. Null on the first refine of a session. */
export interface PreviousRefine {
  title: string;
  summary: string;
  conclusions: readonly string[];
  todos: readonly PreviousRefineTodo[];
}

export type CandidateTopicZone = "active" | "history";

/**
 * Caller-supplied topic candidate. History topics are oldest-first unless
 * `recency` is set (larger means more recent).
 */
export interface CandidateTopic {
  topicId: string;
  name: string;
  aliases: readonly string[];
  summary: string;
  zone: CandidateTopicZone;
  recency?: number;
}

export interface OpenTodo {
  todoId: string;
  topicId: string;
  text: string;
}

export interface RefineSessionInput {
  sessionKey: string;
  fileId: string;
  source: string;
  /** Messages already incorporated. New messages are the ones passed in `messages`. */
  refinedUpTo: number;
  /** New messages only, oldest first, starting at refinedUpTo + 1. */
  messages: readonly RefineMessage[];
  previous: PreviousRefine | null;
  topics: readonly CandidateTopic[];
  openTodos: readonly OpenTodo[];
}

export interface RefineEventStamp {
  ts: string;
  device: string;
  seq: number;
}

/** Supplies ts, device, and seq. Event ids are ULIDs from RefineIdSource. */
export type RefineEventFactory = () => RefineEventStamp;

export interface RefineIdSource {
  eventId: () => string;
  topicId: () => string;
  conclusionId: () => string;
  todoId: () => string;
}

export interface RefineSessionOptions {
  eventFactory: RefineEventFactory;
  ids?: RefineIdSource;
  /** Character budget for new messages. The earliest text is dropped first. */
  charBudget?: number;
  historyLimit?: number;
}

export interface RefineCompleted {
  status: "refined";
  output: RefineOutput;
  events: Event[];
}

export interface RefineSkipped {
  status: "skipped";
  reason: "invalid_output" | "no_new_messages";
  attempts: number;
  detail: string;
}

export type RefineResult = RefineCompleted | RefineSkipped;

export function isRefineSkipped(result: RefineResult): result is RefineSkipped {
  return result.status === "skipped";
}
