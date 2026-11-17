import { createHash } from "node:crypto";

import type { QuotaWindow } from "./types.js";

/** One account as magpie printed it; `windows` is empty when magpie could not read its allowance this time. */
export interface ParsedQuotaAccount {
  id: string;
  agent: string;
  plan: string | null;
  active: boolean;
  windows: QuotaWindow[];
  /** When magpie itself read these numbers; null when magpie did not say. */
  asOf: string | null;
}

function accountId(agent: string, user: unknown): string {
  const who = typeof user === "string" ? user : "";
  return createHash("sha256").update(`${agent}\u0000${who}`).digest("hex").slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWindow(value: unknown): QuotaWindow | null {
  if (!isRecord(value)) return null;
  const { name, used, resetsAt } = value;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  const reset = typeof resetsAt === "string" && !Number.isNaN(Date.parse(resetsAt)) ? resetsAt : null;
  return { name: name.trim(), used: Math.min(100, Math.max(0, used)), resetsAt: reset };
}

/**
 * Reads `magpie accounts --json`. Null means the output is not a usable account list.
 * Accounts come back even without a readable window: magpie sometimes fails to read one
 * subscription, and the caller decides whether to keep the earlier numbers.
 * `asOf` is magpie's own read time (often a cache: Claude Code's numbers come from its
 * local file and may be days old), so the UI can tell live numbers from stale ones.
 */
export function parseMagpieAccounts(stdout: string): ParsedQuotaAccount[] | null {
  // magpie prints a plugin log line before the JSON.
  const start = stdout.search(/^\[/mu);
  if (start < 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const accounts: ParsedQuotaAccount[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.agent !== "string") continue;
    const windows = Array.isArray(item.windows)
      ? item.windows.map(parseWindow).filter((window): window is QuotaWindow => window !== null)
      : [];
    // magpie puts its own read time in `readAt` and the source's cache time in `asOf`;
    // the older of the two is when these numbers were actually true.
    const times = [item.readAt, item.asOf].filter(
      (time): time is string => typeof time === "string" && !Number.isNaN(Date.parse(time)),
    );
    const asOf = times.length === 0 ? null : times.reduce((oldest, time) => (Date.parse(time) < Date.parse(oldest) ? time : oldest));
    accounts.push({
      id: accountId(item.agent, item.user),
      agent: item.agent,
      plan: typeof item.plan === "string" && item.plan !== "" ? item.plan : null,
      active: item.active === true,
      windows,
      asOf,
    });
  }
  return accounts;
}
