/**
 * Reminder kinds. New reminders are always `recall` and raise a system notification;
 * `recall_quiet` stays a valid value so old records still fold and display.
 */
export const RECALL_KIND = { notify: "recall", quiet: "recall_quiet" } as const;
export type RecallKind = (typeof RECALL_KIND)[keyof typeof RECALL_KIND];

/** How much of the user's own words the model sees, newest first. */
export const RECALL_USER_CHARS = 6_000;
export const RECALL_TEXT_MAX = 60;
/** Below this text-match score a session is not taken to belong to any topic. */
export const RECALL_MIN_SCORE = 0.25;
export const RECALL_CONCLUSIONS = 10;
export const RECALL_TODOS = 20;
export const RECALL_ITEM_CHARS = 300;
export const RECALL_TOPIC_COOLDOWN_MS = 24 * 60 * 60_000;
export const RECALL_DAILY_LIMIT = 5;
export const RECALL_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

export type RecallGrade = "important" | "normal";

export interface RecallMemoryItem {
  id: string;
  kind: "next_step" | "todo" | "conclusion";
  text: string;
  /** Local date the item was written, `YYYY-MM-DD`. */
  day: string | null;
  /** Session that wrote it; null for the topic's next step. */
  sessionKey: string | null;
}

export interface RecallMemory {
  topicId: string;
  name: string;
  summary: string;
  /** Last day another session touched this topic. */
  lastActiveDay: string | null;
  items: RecallMemoryItem[];
}

export type RecallDecision =
  | { say: false }
  | { say: true; grade: RecallGrade; text: string; basisId: string };

/**
 * A session last written longer ago than this is history being rescanned (a restart, a
 * full re-index), not a conversation going on: it is never considered.
 */
export const RECALL_FRESH_MS = 10 * 60_000;

/**
 * Only old work is recalled. A session written within this window is still the present:
 * the conversation itself, a second capture of it from another tool, or something just
 * discussed elsewhere. None of its todos or conclusions are handed back as a reminder.
 */
export const RECALL_RECENT_MS = 12 * 60 * 60_000;
