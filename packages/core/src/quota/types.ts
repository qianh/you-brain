/** One allowance window of a subscription, as magpie reports it. */
export interface QuotaWindow {
  /** magpie's own name: "5 hours", "7 days", "7 days · Fable", "30 days". */
  name: string;
  /** Percent used, 0–100. */
  used: number;
  /** ISO time the window resets; null when magpie does not say. */
  resetsAt: string | null;
}

/** One signed-in subscription. The account's email never leaves the parser. */
export interface QuotaAccount {
  /** Stable per account across reads: a short hash of agent and sign-in, never the email itself. */
  id: string;
  /** magpie's agent id: claude, codex, grok, zcode … */
  agent: string;
  plan: string | null;
  active: boolean;
  windows: QuotaWindow[];
  /**
   * When these numbers were true as far as magpie knows. Often older than the last read:
   * magpie caches, and Claude Code's numbers come from its local file. The UI marks an
   * account stale when this falls too far behind, not when the read merely succeeded.
   */
  readAt: string;
  /** The latest read had no numbers for this account, so these are kept from an earlier one. */
  stale: boolean;
}

/** Token totals one agent has pushed through its routes over one span. */
export interface QuotaTokens {
  calls: number;
  /** Request tokens as sent upstream. */
  input: number;
  /** Completion tokens. */
  output: number;
  /** Cache-read tokens; large for long sessions. */
  cacheRead: number;
  /** Input + output + cache read, the number shown. */
  total: number;
}

/** One agent's token consumption over the three spans the panel shows, in display order. */
export interface QuotaTokenUsage {
  /** Since local midnight. */
  today: QuotaTokens;
  /** Since local midnight two days ago, three calendar days including today. */
  threeDays: QuotaTokens;
  /** Since local midnight six days ago, seven calendar days including today. */
  sevenDays: QuotaTokens;
}

export interface QuotaView {
  accounts: QuotaAccount[];
  /** Token usage per agent over the three spans; empty when magpie's request log is missing. */
  tokens: Record<string, QuotaTokenUsage>;
  /** When the last successful refresh ran; null until then. */
  readAt: string | null;
  /** The last refresh failed, so `accounts` are from an earlier read. */
  stale: boolean;
}
