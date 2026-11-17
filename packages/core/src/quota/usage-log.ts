import { open } from "node:fs/promises";

import type { QuotaTokens, QuotaTokenUsage } from "./types.js";

/** magpie's request log override, when its config dir is not the default one. */
export const USAGE_LOG_ENV = "YOU_BRAIN_MAGPIE_USAGE_LOG";

/**
 * Only the newest records can matter (the oldest window is seven days), so a log that has
 * grown past this is read from the tail. At roughly 1 MB a day the cap is years away.
 */
const USAGE_LOG_TAIL_BYTES = 64 * 1024 * 1024;

/** magpie's own request log, one JSON line per routed request: ~/.config/magpie/usage.jsonl. */
export function usageLogPath(input: { env: NodeJS.ProcessEnv; homeDir: string }): string {
  const configured = input.env[USAGE_LOG_ENV]?.trim();
  if (configured) return configured;
  return `${input.homeDir}/.config/magpie/usage.jsonl`;
}

/** Reads the request log (tail-capped); rejects when the file is missing or unreadable. */
export async function readMagpieUsageLog(input: {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): Promise<string> {
  const handle = await open(usageLogPath(input), "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - USAGE_LOG_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    // A capped read starts mid-line: drop the truncated first one.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}

/** The spans' lower bounds, local-midnight aligned like magpie's own 7-day report. */
export interface TokenWindowCutoffs {
  today: number;
  threeDays: number;
  sevenDays: number;
}

export function tokenWindowCutoffs(nowMs: number): TokenWindowCutoffs {
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  const midnight = day.getTime();
  return { today: midnight, threeDays: midnight - 2 * 86_400_000, sevenDays: midnight - 6 * 86_400_000 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

const EMPTY: QuotaTokens = { calls: 0, input: 0, output: 0, cacheRead: 0, total: 0 };

/**
 * Sums each wanted agent's tokens over 今天 / 近 3 天 / 近 7 天 from the request log,
 * keyed by the log's agent field ("codex"). Unparseable lines and other agents are
 * skipped; a log with none of the wanted agents comes back as an empty record.
 */
export function parseUsageLog(
  text: string,
  agents: ReadonlyArray<string>,
  cutoffs: TokenWindowCutoffs,
): Record<string, QuotaTokenUsage> {
  const wanted = new Set(agents);
  const totals = new Map<string, [QuotaTokens, QuotaTokens, QuotaTokens]>();
  for (const line of text.split("\n")) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row) || typeof row.agent !== "string" || !wanted.has(row.agent)) continue;
    const at = Date.parse(typeof row.t === "string" ? row.t : "");
    if (Number.isNaN(at) || at > cutoffs.today + 86_400_000) continue;
    const input = int(row.in);
    const output = int(row.out);
    const cacheRead = int(row.cache_read);
    const tokens: QuotaTokens = { calls: 1, input, output, cacheRead, total: input + output + cacheRead };
    let entry = totals.get(row.agent);
    if (!entry) {
      entry = [{ ...EMPTY }, { ...EMPTY }, { ...EMPTY }];
      totals.set(row.agent, entry);
    }
    // The bounds are ordered today > threeDays > sevenDays; a row inside a span counts
    // toward it and every wider one.
    if (at >= cutoffs.today) {
      for (const bucket of entry) addInto(bucket, tokens);
    } else if (at >= cutoffs.threeDays) {
      addInto(entry[1] as QuotaTokens, tokens);
      addInto(entry[2] as QuotaTokens, tokens);
    } else if (at >= cutoffs.sevenDays) {
      addInto(entry[2] as QuotaTokens, tokens);
    }
  }
  const out: Record<string, QuotaTokenUsage> = {};
  for (const [agent, [today, threeDays, sevenDays]] of totals) out[agent] = { today, threeDays, sevenDays };
  return out;
}

function addInto(bucket: QuotaTokens, tokens: QuotaTokens): void {
  bucket.calls += tokens.calls;
  bucket.input += tokens.input;
  bucket.output += tokens.output;
  bucket.cacheRead += tokens.cacheRead;
  bucket.total += tokens.total;
}
