import type { Event } from "@you-brain/protocol";

import type { SortKey } from "./types.js";

export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function eventSortKey(event: Event): SortKey {
  const tsMs = Date.parse(event.ts);
  if (Number.isNaN(tsMs)) {
    throw new Error(`Event ${event.id} has an invalid timestamp`);
  }
  return { tsMs, device: event.device, seq: event.seq, id: event.id };
}

export function compareSortKeys(left: SortKey, right: SortKey): number {
  if (left.tsMs !== right.tsMs) return left.tsMs < right.tsMs ? -1 : 1;
  if (left.device !== right.device) return left.device < right.device ? -1 : 1;
  if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1;
  return compareText(left.id, right.id);
}

export function compareEvents(left: Event, right: Event): number {
  return compareSortKeys(eventSortKey(left), eventSortKey(right));
}
