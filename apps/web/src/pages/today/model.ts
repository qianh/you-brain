import type { Language } from "../../lib/format.js";
import { formatDay, zonedParts, type ZonedParts } from "../../lib/format.js";
import { sessionStamp } from "../../lib/group.js";

export type TodayMode = "topic" | "time";

const MODE_KEY = "you-brain-today-mode";

export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readTodayMode(storage: ModeStorage | null): TodayMode {
  try {
    return storage?.getItem(MODE_KEY) === "time" ? "time" : "topic";
  } catch {
    return "topic";
  }
}

export function writeTodayMode(storage: ModeStorage | null, mode: TodayMode): void {
  try {
    storage?.setItem(MODE_KEY, mode);
  } catch {
    // Private mode and disabled storage keep the in-memory choice.
  }
}

export function formatTodayHeading(isoDate: string, language: Language): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(isoDate);
  if (!match) return isoDate;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const locale = language === "zh" ? "zh-CN" : "en-US";
  let weekday = "";
  try {
    weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(date);
  } catch {
    weekday = "";
  }
  const heading = formatDay(isoDate, language);
  return weekday === "" ? heading : `${heading} · ${weekday}`;
}

export function formatCount(value: number, language: Language): string {
  const locale = language === "zh" ? "zh-CN" : "en-US";
  return new Intl.NumberFormat(locale).format(value);
}

export interface StatSession {
  source: string;
  topicId: string | null;
  todos: readonly { status: string }[];
}

export interface TodayStats {
  sessions: number;
  sources: number;
  topics: number;
  unassigned: number;
  openTodos: number;
  doneTodos: number;
}

export function summarizeToday(sessions: readonly StatSession[]): TodayStats {
  const sources = new Set<string>();
  const topics = new Set<string>();
  let unassigned = 0;
  let openTodos = 0;
  let doneTodos = 0;
  for (const session of sessions) {
    if (session.source !== "") sources.add(session.source);
    if (session.topicId === null) unassigned += 1;
    else topics.add(session.topicId);
    for (const todo of session.todos) {
      if (todo.status === "done") doneTodos += 1;
      else if (todo.status !== "dropped") openTodos += 1;
    }
  }
  return {
    sessions: sessions.length,
    sources: sources.size,
    topics: topics.size,
    unassigned,
    openTodos,
    doneTodos,
  };
}

export type GuideId = "drive" | "model" | "capture";
export type GuideSection = "account" | "model" | "integrations";

export interface GuideInput {
  driveReachable: boolean | null;
  warnings: readonly { code: string }[];
  sessionCount: number;
  lastSyncAt: string | null;
}

export interface GuideStep {
  id: GuideId;
  done: boolean;
  section: GuideSection;
}

export function guideSteps(input: GuideInput): GuideStep[] {
  const modelDone = !input.warnings.some((warning) => warning.code.startsWith("LLM_"));
  const captureDone = input.sessionCount > 0 || input.lastSyncAt !== null;
  return [
    { id: "drive", done: input.driveReachable === true, section: "account" },
    { id: "model", done: modelDone, section: "model" },
    { id: "capture", done: captureDone, section: "integrations" },
  ];
}

export function guideSummary(steps: readonly { done: boolean }[]): { done: number; total: number; visible: boolean } {
  const done = steps.filter((step) => step.done).length;
  return { done, total: steps.length, visible: done < steps.length };
}

/** Completed steps collapse into one summary only while unfinished steps remain. */
export function foldGuideSteps<T extends { done: boolean }>(steps: readonly T[]): {
  done: T[];
  pending: T[];
  collapsed: boolean;
} {
  const done: T[] = [];
  const pending: T[] = [];
  for (const step of steps) {
    if (step.done) done.push(step);
    else pending.push(step);
  }
  return { done, pending, collapsed: done.length > 0 && pending.length > 0 };
}

export function joinGuideNames(names: readonly string[], separator: string): string {
  return names.filter((name) => name !== "").join(separator);
}

export interface TimedSession {
  sessionKey: string;
  updatedAt: string | null;
  startedAt?: string | null;
}

export function sessionMoment(session: TimedSession): string | null {
  if (session.updatedAt !== null && session.updatedAt !== "") return session.updatedAt;
  if (session.startedAt !== undefined && session.startedAt !== null && session.startedAt !== "") return session.startedAt;
  return null;
}

export interface HourGroup<T> {
  key: string;
  label: string;
  sessions: T[];
}

function hourBucket(parts: ZonedParts): { key: string; label: string } {
  const next = (Number(parts.hour) + 1) % 24;
  const end = String(next).padStart(2, "0");
  return {
    key: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}-${parts.hour}`,
    label: `${parts.hour}:00 – ${end}:00`,
  };
}

export function groupSessionsByHour<T extends TimedSession>(
  sessions: readonly T[],
  timeZone: string,
  unknownLabel: string,
): HourGroup<T>[] {
  const ordered = [...sessions].sort((left, right) => {
    const delta = sessionStamp(sessionMoment(right)) - sessionStamp(sessionMoment(left));
    if (delta !== 0 && !Number.isNaN(delta)) return delta;
    if (left.sessionKey < right.sessionKey) return -1;
    if (left.sessionKey > right.sessionKey) return 1;
    return 0;
  });
  const groups: HourGroup<T>[] = [];
  const index = new Map<string, HourGroup<T>>();
  for (const session of ordered) {
    const stamp = sessionMoment(session);
    let key = "unknown";
    let label = unknownLabel;
    if (stamp !== null) {
      const date = new Date(stamp);
      if (!Number.isNaN(date.getTime())) {
        const bucket = hourBucket(zonedParts(date, timeZone));
        key = bucket.key;
        label = bucket.label;
      }
    }
    const existing = index.get(key);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    const created: HourGroup<T> = { key, label, sessions: [session] };
    index.set(key, created);
    groups.push(created);
  }
  return groups;
}

export function latestMoment(sessions: readonly TimedSession[]): string | null {
  let best: string | null = null;
  let bestStamp = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    const moment = sessionMoment(session);
    const stamp = sessionStamp(moment);
    if (stamp > bestStamp) {
      bestStamp = stamp;
      best = moment;
    }
  }
  return best;
}

export function arrivedKeys(previous: ReadonlySet<string> | null, next: readonly string[]): string[] {
  if (previous === null) return [];
  return next.filter((key) => !previous.has(key));
}

export function topicZone(
  topics: readonly { topicId: string; zone: "active" | "history" }[],
  topicId: string,
): "active" | "history" {
  return topics.find((topic) => topic.topicId === topicId)?.zone ?? "active";
}
