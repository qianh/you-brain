import { createEvent, ulid, type Event, type RefineOutput } from "@you-brain/protocol";

import type { RefineEventFactory, RefineIdSource, RefineSessionInput } from "./types.js";

export function defaultRefineIds(now = Date.now()): RefineIdSource {
  return {
    eventId: () => ulid(now),
    topicId: () => ulid(now),
    conclusionId: () => ulid(now),
    todoId: () => ulid(now),
  };
}

export function createRefineEventFactory(input: {
  device: string;
  ts: string | (() => string);
  startSeq: number;
}): RefineEventFactory {
  let seq = input.startSeq;
  return () => {
    const current = seq;
    seq += 1;
    return {
      device: input.device,
      ts: typeof input.ts === "function" ? input.ts() : input.ts,
      seq: current,
    };
  };
}

export function refineToEvents(
  input: Pick<RefineSessionInput, "sessionKey" | "fileId" | "source" | "refinedUpTo" | "messages">,
  output: RefineOutput,
  eventFactory: RefineEventFactory,
  ids: RefineIdSource,
): Event[] {
  const events: Event[] = [];
  const stamp = () => {
    const next = eventFactory();
    return { ts: next.ts, device: next.device, seq: next.seq, id: ids.eventId() };
  };

  events.push(
    createEvent({
      type: "session.refined",
      ...stamp(),
      data: {
        sessionKey: input.sessionKey,
        fileId: input.fileId,
        source: input.source,
        title: output.title,
        summary: output.summary,
        refinedUpTo: input.refinedUpTo + input.messages.length,
      },
    }),
  );

  const topicId = output.topic.topicId;
  if (output.topic.action === "create") {
    events.push(
      createEvent({
        type: "topic.created",
        ...stamp(),
        data: {
          topicId,
          name: output.topic.name,
          aliases: output.topic.aliases,
        },
      }),
    );
  }
  events.push(
    createEvent({
      type: "topic.assigned",
      ...stamp(),
      data: { topicId, sessionKey: input.sessionKey },
    }),
  );
  for (const text of output.conclusions_added) {
    events.push(
      createEvent({
        type: "conclusion.added",
        ...stamp(),
        data: {
          conclusionId: ids.conclusionId(),
          topicId,
          text,
          sessionKey: input.sessionKey,
        },
      }),
    );
  }
  for (const todo of output.todos_added) {
    events.push(
      createEvent({
        type: "todo.added",
        ...stamp(),
        data: {
          todoId: ids.todoId(),
          topicId,
          text: todo.text,
          sessionKey: input.sessionKey,
          confidence: todo.confidence,
        },
      }),
    );
  }
  for (const todoId of output.todos_completed) {
    events.push(
      createEvent({
        type: "todo.status_changed",
        ...stamp(),
        data: { todoId, status: "done", by: "auto" },
      }),
    );
  }
  return events;
}
