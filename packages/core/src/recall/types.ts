/** Reminder kinds. `recall_quiet` is listed like any reminder but never raises a system notification. */
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
/** A result later than this is "late". Only a normal reminder is held back for it. */
export const RECALL_LATE_MS = 5 * 60_000;
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
