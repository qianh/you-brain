export const INTERVALS = {
  tickMs: 1_000,
  flushMs: 30_000,
  heartbeatMs: 5 * 60_000,
  pullMs: 60_000,
  fastPullMs: 5_000,
  fullScanMs: 10 * 60_000,
  reminderMs: 10 * 60_000,
  consolidationMs: 10 * 60_000,
  portraitMs: 24 * 60 * 60_000,
  searchMs: 60_000,
  outputDebounceMs: 10_000,
  watchDebounceMs: 250,
  /** Quiet period after the last topic-book change before Drive topic files sync. */
  topicFilesDebounceMs: 5 * 60_000,
  /** How often the web-session processor looks for idle `inbox/web-` sessions. */
  webSessionsMs: 60_000,
  /** Coalesce webhook sends after an event lands. Never wait longer than this. */
  webhookDebounceMs: 2_000,
  /** Retry sweep. Backoff is enforced by the delivery state, not by this interval. */
  webhookMs: 60_000,
} as const;

/** `last === null` means the job has never run and is due immediately. */
export function intervalDue(last: number | null, now: number, everyMs: number): boolean {
  if (last === null) return true;
  return now - last >= everyMs;
}

/** SSE subscribers pull every 5 seconds. Otherwise the poll stays at 60 seconds. */
export function pullInterval(subscribers: number): number {
  return subscribers > 0 ? INTERVALS.fastPullMs : INTERVALS.pullMs;
}
