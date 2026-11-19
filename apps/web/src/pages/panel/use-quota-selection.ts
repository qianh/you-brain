import { useMemo, useSyncExternalStore } from "react";

import { prefs } from "../../lib/prefs.js";
import { QUOTA_AGENTS, quotaSelection, type QuotaAgent, type QuotaCaptures } from "./quota.js";

const KEY = "you-brain.quota-display";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let received: string | null = null;

function getStored(): string | null {
  return received ?? prefs.getItem(KEY);
}

function publish(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (channel === null && typeof window !== "undefined" && typeof window.BroadcastChannel === "function") {
    channel = new BroadcastChannel(KEY);
    channel.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      received = data;
      publish();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    channel?.close();
    channel = null;
  };
}

export function useQuotaSelection(captures: QuotaCaptures, nowMs = Date.now()) {
  const stored = useSyncExternalStore(subscribe, getStored, getStored);
  const selected = useMemo(() => quotaSelection(stored, captures, nowMs), [stored, captures, nowMs]);

  function setChecked(agent: QuotaAgent, checked: boolean): void {
    const next = quotaSelection(getStored(), captures, nowMs);
    if (checked) next.add(agent);
    else next.delete(agent);
    const value = JSON.stringify(QUOTA_AGENTS.map((item) => item.agent).filter((id) => next.has(id)));
    prefs.setItem(KEY, value);
    received = null;
    publish();
    channel?.postMessage(value);
  }

  return { selected, setChecked };
}
