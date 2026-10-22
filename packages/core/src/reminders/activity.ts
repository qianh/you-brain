/** Desktop shells may report a timestamp slightly ahead of the daemon clock. */
export const ACTIVITY_FUTURE_SLACK_MS = 60_000;

/** Older than this is not a live key or pointer event. */
export const ACTIVITY_PAST_LIMIT_MS = 60 * 60_000;

export function acceptActivityAt(input: {
  at: string | undefined;
  now: string;
}): { ok: true; at: string } | { ok: false } {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) return { ok: false };
  if (input.at === undefined) return { ok: true, at: new Date(nowMs).toISOString() };
  const ms = Date.parse(input.at);
  if (Number.isNaN(ms)) return { ok: false };
  if (ms > nowMs + ACTIVITY_FUTURE_SLACK_MS) return { ok: false };
  if (ms < nowMs - ACTIVITY_PAST_LIMIT_MS) return { ok: false };
  return { ok: true, at: new Date(ms).toISOString() };
}
