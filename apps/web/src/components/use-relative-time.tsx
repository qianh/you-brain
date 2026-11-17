import { useSyncExternalStore } from "react";

import { formatRelative, type Language } from "../lib/format.js";

/*
 * One minute clock shared by every relative label. The topic list has a thousand rows; a timer
 * per row meant a thousand separate updates every minute. The clock stops with no subscribers.
 */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

const snapshot = (): number => now;

/** Re-renders once a minute so relative labels stay current. */
export function useRelativeTime(iso: string | null, language: Language, timeZone?: string): string {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return formatRelative(iso, language, timeZone, current);
}
