import { localParts, timeZoneOffsetMinutes } from "../reminders/time.js";
import type { DeckSchedule, DeckTask } from "./types.js";

/** 周期任务检查间隔；实际执行仍由 daemon tick 驱动。 */
export const DECK_TICK_MS = 60_000;

function parseClock(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(time.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 最近一次「已到期但按 lastRunAt 还没跑」的本地时刻（毫秒），没有则 null。
 * daily：今天的 HH:MM（含错过补跑——lastRun 在该时刻之前即到期，只补最近一次）。
 * interval：now - lastRun >= minutes；从没跑过视为到期。
 */
export function taskDueMs(
  task: Pick<DeckTask, "schedule" | "lastRunAt">,
  nowMs: number,
  timeZone: string,
): number | null {
  const lastRunMs = task.lastRunAt === null ? null : Date.parse(task.lastRunAt);
  if (task.schedule.kind === "interval") {
    if (lastRunMs === null || Number.isNaN(lastRunMs)) return nowMs;
    return nowMs - lastRunMs >= task.schedule.minutes * 60_000 ? nowMs : null;
  }
  const clock = parseClock(task.schedule.time);
  if (!clock) return null;
  let offset: number;
  try {
    offset = timeZoneOffsetMinutes(timeZone, new Date(nowMs));
  } catch {
    return null;
  }
  const parts = localParts(nowMs, offset);
  const todayOccurrence = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    clock.hour,
    clock.minute,
  ) - offset * 60_000;
  if (Number.isNaN(lastRunMs) || lastRunMs === null) {
    return nowMs >= todayOccurrence ? todayOccurrence : null;
  }
  if (lastRunMs < todayOccurrence && nowMs >= todayOccurrence) return todayOccurrence;
  return null;
}

export function describeSchedule(schedule: DeckSchedule): string {
  if (schedule.kind === "daily") return `每天 ${schedule.time}`;
  if (schedule.minutes % (60 * 24) === 0) return `每 ${schedule.minutes / (60 * 24)} 天`;
  if (schedule.minutes % 60 === 0) return `每 ${schedule.minutes / 60} 小时`;
  return `每 ${schedule.minutes} 分钟`;
}

export function describeExecutor(executor: { kind: string; id: string }): string {
  switch (executor.kind) {
    case "cli-agent":
      return `本机 agent ${executor.id}`;
    case "model":
      return `模型 ${executor.id}`;
    case "capability":
      return `能力 ${executor.id}`;
    case "gui-app":
      return `App ${executor.id}`;
    default:
      return `${executor.kind}:${executor.id}`;
  }
}
