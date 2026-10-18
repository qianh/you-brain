// SqliteStore can lease outbox rows, but it cannot list or release them.
// This cursor is the ordered retry queue; each event is also stored in outbox.
import { parseEvent, type Event } from "@you-brain/protocol";

import { YouBrainError } from "../domain/errors.js";
import { outboxCursorKey } from "./cursors.js";
import type { SyncStore } from "./types.js";

export function readOutboxQueue(store: SyncStore, deviceId: string): Event[] {
  const raw = store.getCursor(outboxCursorKey(deviceId));
  if (raw === null || raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new YouBrainError("INVALID_INPUT", "Event outbox cursor is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new YouBrainError("INVALID_INPUT", "Event outbox cursor is not a list");
  }
  return parsed.map((item) => parseEvent(item));
}

export function writeOutboxQueue(
  store: SyncStore,
  deviceId: string,
  events: readonly Event[],
): void {
  store.setCursor(outboxCursorKey(deviceId), JSON.stringify(events));
}
