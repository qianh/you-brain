export const INTERVALS = {
  tickMs: 1_000,
  flushMs: 30_000,
  /** One upload batch runs for at most this long before the loop yields. */
  uploadBudgetMs: 20_000,
  /** Pause between upload batches so pull, flush, and scan can use the connection pool. */
  uploadLoopGapMs: 100,
  /** One tick indexes queued inbox files for at most this long. The rest wait for the next tick. */
  inboxBudgetMs: 15_000,
  heartbeatMs: 5 * 60_000,
  pullMs: 60_000,
  fastPullMs: 5_000,
  fullScanMs: 10 * 60_000,
  reminderMs: 10 * 60_000,
  consolidationMs: 10 * 60_000,
  portraitMs: 24 * 60 * 60_000,
  searchMs: 60_000,
  /** Notion 知识库轮询。无变化时每轮只有一次 search 调用,5 分钟很安全。 */
  notionMs: 5 * 60_000,
  outputDebounceMs: 10_000,
  watchDebounceMs: 250,
  /** Quiet period after the last topic-book change before Drive topic files sync. */
  topicFilesDebounceMs: 5 * 60_000,
  /** How often the web-session processor looks for idle `inbox/web-` sessions. */
  webSessionsMs: 60_000,
  /**
   * A subscription CLI that answers nothing twice in a row is paused for this long
   * before the next attempt, doubling on each further stall up to {@link cliStallMaxMs}.
   */
  cliStallMinMs: 10 * 60_000,
  cliStallMaxMs: 60 * 60_000,
  /** Sessions refined per pass. Calls run one after another, so this only sets how
   * often the pass pauses for `refineBackfillMs` between batches. */
  refineBackfillBatch: 8,
  /** Pause between backfill passes so the normal tick work keeps running. */
  refineBackfillMs: 15_000,
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
