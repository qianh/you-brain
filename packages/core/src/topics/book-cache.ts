import type { Event } from "@you-brain/protocol";

import { applyEvents, foldEvents } from "./fold.js";
import type { TopicBook } from "./types.js";

/**
 * `foldEvents` with a memory of the last call. The daemon folds every event (19k and
 * growing) many times a tick: the topic book, reminders, sync, page requests. Each fold
 * took 0.7-2 s on the main thread.
 *
 * The store hands out the same frozen event objects until the table changes, so when the
 * previous list is a prefix of this one (element by element), only the tail is new and
 * `applyEvents` adds it; it refolds by itself when a new event sorts before the last one.
 * Any other list is folded from scratch, exactly as before.
 */
let last: { events: readonly Event[]; book: TopicBook } | null = null;

export function foldEventsCached(events: readonly Event[]): TopicBook {
  const previous = last;
  if (previous !== null && events.length >= previous.events.length && startsWith(events, previous.events)) {
    const book =
      events.length === previous.events.length
        ? previous.book
        : applyEvents(previous.book, events.slice(previous.events.length));
    last = { events, book };
    return book;
  }
  const book = foldEvents(events);
  last = { events, book };
  return book;
}

function startsWith(events: readonly Event[], prefix: readonly Event[]): boolean {
  for (let index = 0; index < prefix.length; index += 1) {
    if (events[index] !== prefix[index]) return false;
  }
  return true;
}
