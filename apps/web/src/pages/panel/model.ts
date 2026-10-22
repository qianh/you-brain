import { zonedParts } from "../../lib/format.js";
import { sessionStamp } from "../../lib/group.js";
import type { ShortcutEvent, ShortcutMod } from "../../lib/shortcuts.js";

export interface RankedTopic {
  topicId: string;
  name: string;
  lastActive: string | null;
}

export const PANEL_TOPIC_LIMIT = 3;

export function recentTopics<T extends RankedTopic>(topics: readonly T[], limit = PANEL_TOPIC_LIMIT): T[] {
  return [...topics]
    .sort((left, right) => {
      const delta = sessionStamp(right.lastActive) - sessionStamp(left.lastActive);
      if (delta !== 0) return delta;
      return left.name.localeCompare(right.name, "zh");
    })
    .slice(0, Math.max(0, limit));
}

export function countSessionsByTopic(sessions: readonly { topicId: string | null }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (session.topicId === null) continue;
    counts.set(session.topicId, (counts.get(session.topicId) ?? 0) + 1);
  }
  return counts;
}

export function takeWithRest<T>(items: readonly T[], limit: number): { visible: T[]; rest: number } {
  const cap = Math.max(0, limit);
  return { visible: items.slice(0, cap), rest: Math.max(0, items.length - cap) };
}

/** Most recent topics for the panel, plus how many the "view all" line must cover. */
export function panelTopicSlice<T extends RankedTopic>(
  topics: readonly T[],
  limit = PANEL_TOPIC_LIMIT,
): { visible: T[]; rest: number; total: number } {
  const ranked = recentTopics(topics, topics.length);
  const slice = takeWithRest(ranked, limit);
  return { ...slice, total: topics.length };
}

export function clockTime(iso: string | null, timeZone: string): string {
  if (iso === null || iso.trim() === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = zonedParts(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function topicDotClass(status: string): string {
  if (status === "active") return "dot-ok";
  if (status === "follow_up") return "dot-warn";
  if (status === "done") return "dot-accent";
  return "dot-muted";
}

export type PanelShortcut = "close" | "open" | "refresh";

export function panelShortcut(event: ShortcutEvent, mod: ShortcutMod): PanelShortcut | null {
  if (event.key === "Escape" && !event.meta && !event.ctrl && !event.alt && !event.shift) return "close";
  const modified = mod === "meta" ? event.meta : event.ctrl;
  const other = mod === "meta" ? event.ctrl : event.meta;
  if (!modified || other || event.alt || event.shift) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === "o") return "open";
  if (key === "r") return "refresh";
  return null;
}
