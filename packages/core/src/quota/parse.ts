import type { QuotaAccount, QuotaWindow } from "./types.js";

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
 * Reads `magpie accounts --json`. Null means the output is not a usable account list;
 * accounts without a single readable window (signed out) are dropped.
 */
export function parseMagpieAccounts(stdout: string): QuotaAccount[] | null {
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
  const accounts: QuotaAccount[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.agent !== "string") continue;
    const windows = Array.isArray(item.windows)
      ? item.windows.map(parseWindow).filter((window): window is QuotaWindow => window !== null)
      : [];
    if (windows.length === 0) continue;
    accounts.push({
      agent: item.agent,
      plan: typeof item.plan === "string" && item.plan !== "" ? item.plan : null,
      active: item.active === true,
      windows,
    });
  }
  return accounts;
}
