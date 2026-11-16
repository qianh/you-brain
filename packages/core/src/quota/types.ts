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
  /** When these windows were read. Older than the view's `readAt` when the account is `stale`. */
  readAt: string;
  /** The latest read had no numbers for this account, so these are kept from an earlier one. */
  stale: boolean;
}

export interface QuotaView {
  accounts: QuotaAccount[];
  /** When the numbers were read; null until the first successful read. */
  readAt: string | null;
  /** The last refresh failed, so `accounts` are from an earlier read. */
  stale: boolean;
}
