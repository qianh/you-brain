import type { QuotaTokenUsage, QuotaView } from "@you-brain/core/http/types.js";

import type { Language } from "../../lib/format.js";

/**
 * Labels and default capture sources for the agents we know by name. The checkable
 * list itself comes from what magpie returns and what the machine has (see `quotaOptions`).
 */
export const QUOTA_AGENTS: ReadonlyArray<{ agent: string; sources: readonly string[]; label: string }> = [
  { agent: "claude", sources: ["claude-code"], label: "Claude Code" },
  { agent: "codex", sources: ["codex", "t3-code"], label: "Codex" },
  { agent: "cursor", sources: ["cursor"], label: "Cursor" },
  { agent: "grok", sources: ["grok-build"], label: "Grok" },
  { agent: "zcode", sources: ["zcode"], label: "ZCode" },
  { agent: "gemini", sources: ["gemini-cli"], label: "Gemini CLI" },
  { agent: "antigravity", sources: [], label: "Antigravity" },
  { agent: "kimi", sources: [], label: "Kimi CLI" },
  { agent: "opencode", sources: [], label: "OpenCode" },
  { agent: "qwen", sources: [], label: "Qwen Code" },
  { agent: "windsurf", sources: [], label: "Windsurf" },
  { agent: "trae", sources: [], label: "Trae" },
  { agent: "pi", sources: [], label: "Pi" },
];

/** Agents the user asked never to see in the usage display, even when magpie reports them. */
const QUOTA_HIDDEN: ReadonlySet<string> = new Set(["copilot", "qoder", "kiro", "workbuddy-ai"]);

export type QuotaAgent = string;
export type QuotaCaptures = ReadonlyArray<{ source: string; lastCaptureAt: string | null }> | undefined;

export interface QuotaOption {
  agent: QuotaAgent;
  label: string;
}

/**
 * Every agent that can be ticked: the ones found on this machine plus any magpie has
 * numbers for (an active subscription with windows, or gateway token usage). Known ones
 * come first in a fixed order, then the rest by id.
 */
export function quotaOptions(quota: Pick<QuotaView, "accounts" | "tokens" | "local"> | null): QuotaOption[] {
  const ids = new Set<string>(quota?.local ?? []);
  for (const account of quota?.accounts ?? []) {
    if (account.active && account.windows.length > 0) ids.add(account.agent);
  }
  for (const agent of Object.keys(quota?.tokens ?? {})) ids.add(agent);
  const known = QUOTA_AGENTS.filter(({ agent }) => ids.has(agent));
  const knownIds = new Set(known.map(({ agent }) => agent));
  const rest = [...ids].filter((agent) => !knownIds.has(agent)).sort();
  return [...known.map(({ agent, label }) => ({ agent, label })), ...rest.map((agent) => ({ agent, label: agent }))]
    .filter(({ agent }) => !QUOTA_HIDDEN.has(agent));
}

/** A source counts as in use when it captured a session this recently. */
export const QUOTA_RECENT_MS = 7 * 24 * 60 * 60_000;

export function quotaSelection(stored: string | null, captures: QuotaCaptures, nowMs: number): Set<QuotaAgent> {
  if (stored !== null) {
    try {
      const value: unknown = JSON.parse(stored);
      if (Array.isArray(value)) return new Set(value.filter((item): item is string => typeof item === "string"));
    } catch {
      return quotaSelection(null, captures, nowMs);
    }
  }
  const recent = new Set(captures?.filter(({ lastCaptureAt }) => lastCaptureAt !== null &&
    nowMs - Date.parse(lastCaptureAt) <= QUOTA_RECENT_MS).map(({ source }) => source));
  return new Set(QUOTA_AGENTS.filter(({ sources }) => sources.some((source) => recent.has(source))).map(({ agent }) => agent));
}

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
  readAt: string | null;
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
 * Show selected agents in a fixed order, using the account magpie marks active.
 * An agent without a subscription can still show measured gateway token usage.
 */
export function quotaCards(
  quota: Pick<QuotaView, "accounts" | "tokens" | "local"> | null,
  selected: ReadonlySet<QuotaAgent>,
  nowMs: number,
  language: Language,
): QuotaCardView[] {
  const accounts = quota?.accounts ?? [];
  const tokens = quota?.tokens ?? {};
  const cards: QuotaCardView[] = [];
  for (const { agent, label } of quotaOptions(quota)) {
    if (!selected.has(agent)) continue;
    const account = accounts.find((item) => item.agent === agent && item.active && item.windows.length > 0);
    const agentTokens = tokens[agent];
    if (account === undefined && agentTokens === undefined) {
      // Ticked but magpie has nothing for it: still show it, so the tick is visibly honoured.
      cards.push({ agent, label, plan: null, stale: false, readAt: null, windows: [] });
      continue;
    }
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
