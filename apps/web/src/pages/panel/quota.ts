import type { QuotaAccount, QuotaTokenUsage, QuotaView } from "@you-brain/core/http/types.js";

import type { Language } from "../../lib/format.js";

/**
 * magpie's agent id → the session source U-Brain captures it under. Only agents listed
 * here can be shown: without a capture source there is no way to tell whether the
 * subscription is in use. Add a row to show another one.
 */
export const QUOTA_AGENTS: ReadonlyArray<{ agent: string; source: string; label: string }> = [
  { agent: "claude", source: "claude-code", label: "Claude Code" },
  { agent: "codex", source: "codex", label: "Codex" },
  { agent: "grok", source: "grok-build", label: "Grok" },
  { agent: "zcode", source: "zcode", label: "ZCode" },
];

/** A source counts as in use when it captured a session this recently. */
export const QUOTA_RECENT_MS = 7 * 24 * 60 * 60_000;

export type QuotaTone = "ok" | "warn" | "danger";

export interface QuotaWindowView {
  name: string;
  label: string;
  used: number;
  tone: QuotaTone;
  resetsAt: string | null;
}

export interface QuotaCardView {
  agent: string;
  label: string;
  plan: string | null;
  windows: QuotaWindowView[];
  /** magpie could not read this one last time; the numbers are from `readAt`. */
  stale: boolean;
  readAt: string;
  /** Token consumption over 今天 / 近 3 天 / 近 7 天, for agents riding a gateway rather than a subscription. */
  tokens?: QuotaTokenUsage;
}

/** Compact token count: "339.9M", "17.5K", "842". */
export function tokenCount(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${Math.round(total / 1_000)}K`;
  return `${total}`;
}

/** Whole minutes since `readAt`, at least 1. */
export function minutesAgo(readAt: string, nowMs: number): number {
  return Math.max(1, Math.round((nowMs - Date.parse(readAt)) / 60_000));
}

export function quotaTone(used: number): QuotaTone {
  if (used >= 95) return "danger";
  if (used >= 80) return "warn";
  return "ok";
}

/** "5 hours" → "5 小时" in Chinese; anything it does not recognise stays as magpie wrote it. */
export function windowLabel(name: string, language: Language): string {
  if (language !== "zh") return name;
  const match = /^(\d+)\s*(hours?|days?)(.*)$/iu.exec(name);
  if (!match) return name;
  const unit = match[2]?.toLowerCase().startsWith("h") ? "小时" : "天";
  return `${match[1]} ${unit}${match[3] ?? ""}`;
}

/** "5 hours" → "5h", "7 days · Fable" → "7d Fable": the top bar has room for little else. */
export function shortWindowLabel(name: string): string {
  const match = /^(\d+)\s*(hours?|days?)(.*)$/iu.exec(name);
  if (!match) return name;
  const unit = match[2]?.toLowerCase().startsWith("h") ? "h" : "d";
  const rest = (match[3] ?? "").replace(/^\s*·\s*/u, " ").trimEnd();
  return `${match[1]}${unit}${rest}`;
}

/** "4 小时后" / "in 4h"; null when the time is missing or already past (the numbers are old). */
export function resetIn(resetsAt: string | null, nowMs: number, language: Language): string | null {
  if (resetsAt === null) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at) || at <= nowMs) return null;
  const minutes = Math.max(1, Math.round((at - nowMs) / 60_000));
  const zh = language === "zh";
  if (minutes < 60) return zh ? `${minutes} 分钟后` : `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时后` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return zh ? `${days} 天后` : `in ${days}d`;
}

/**
 * Which subscriptions the panel shows, in a fixed order: known agents whose source
 * captured a session in the last 7 days, using the account magpie marks active.
 * An agent with no subscription but mapped token usage (Codex rides the dzg gateway)
 * still gets a card, showing what its traffic cost in tokens. Without capture data
 * nothing is shown.
 */
export function quotaCards(
  quota: Pick<QuotaView, "accounts" | "tokens"> | null,
  captures: ReadonlyArray<{ source: string; lastCaptureAt: string | null }> | undefined,
  nowMs: number,
  language: Language,
): QuotaCardView[] {
  const accounts = quota?.accounts ?? [];
  const tokens = quota?.tokens ?? {};
  const cards: QuotaCardView[] = [];
  for (const { agent, source, label } of QUOTA_AGENTS) {
    const capture = captures?.find((item) => item.source === source);
    const last = capture?.lastCaptureAt ? Date.parse(capture.lastCaptureAt) : Number.NaN;
    if (Number.isNaN(last) || nowMs - last > QUOTA_RECENT_MS) continue;
    const account = accounts.find((item) => item.agent === agent && item.active && item.windows.length > 0);
    const agentTokens = tokens[agent];
    if (account === undefined && agentTokens === undefined) continue;
    const windows = (account?.windows ?? []).map((window) => ({
      name: window.name,
      label: windowLabel(window.name, language),
      used: window.used,
      tone: quotaTone(window.used),
      resetsAt: window.resetsAt,
    }));
    if (agentTokens !== undefined && account === undefined) {
      // A gateway agent with no subscription: the card shows what its traffic cost in tokens.
      cards.push({
        agent,
        label,
        plan: null,
        stale: false,
        readAt: new Date(nowMs).toISOString(),
        windows,
        tokens: agentTokens,
      });
    } else if (account !== undefined) {
      cards.push({
        agent,
        label,
        plan: account.plan,
        stale: account.stale,
        readAt: account.readAt,
        windows,
        ...(agentTokens !== undefined ? { tokens: agentTokens } : {}),
      });
    }
  }
  return cards;
}
