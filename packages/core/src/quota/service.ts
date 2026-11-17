import { ClaudeUsageError, readClaudeAccessToken, readClaudeUsage, type ClaudeUsageWindows } from "./claude-usage.js";
import { parseMagpieAccounts } from "./parse.js";
import type { QuotaAccount, QuotaTokenUsage, QuotaView } from "./types.js";
import { parseUsageLog, tokenWindowCutoffs } from "./usage-log.js";

/** An account whose allowance magpie could not read keeps its last numbers this long. */
export const QUOTA_KEEP_MS = 60 * 60_000;

/**
 * An account whose numbers magpie itself has not refreshed for this long shows as stale:
 * magpie caches, and Claude Code's numbers come from its local file, so a fresh command
 * run does not mean fresh numbers.
 */
export const QUOTA_STALE_MS = 30 * 60_000;

/**
 * The live Claude probe hits Anthropic's own usage endpoint — the one /usage reads on
 * demand. Polling it every refresh got the token rate-limited (429) within a day, so the
 * probe runs at most once in this window, no matter how often magpie itself refreshes.
 */
export const CLAUDE_LIVE_MIN_INTERVAL_MS = 10 * 60_000;

/** First backoff after a failed probe, doubling per consecutive failure… */
export const CLAUDE_LIVE_BACKOFF_MS = 10 * 60_000;

/** …but never waiting longer than this. */
export const CLAUDE_LIVE_BACKOFF_MAX_MS = 60 * 60_000;

/** magpie request-log agent field → the agent's card the token totals are shown under. */
export const TOKEN_AGENTS: ReadonlyArray<{ name: string; agent: string }> = [{ name: "codex", agent: "codex" }];

export interface QuotaPorts {
  /** Runs `magpie accounts --json` and returns its stdout. Rejects on any failure. */
  read(): Promise<string>;
  /** Reads magpie's request log for the token spans; may reject — tokens are optional. */
  readTokens(): Promise<string>;
  /** Probes Anthropic's live usage endpoint for the Claude subscription; may reject. */
  readClaudeLive(): Promise<ClaudeUsageWindows>;
  nowMs(): number;
}

/**
 * Holds the last good quota read. A read takes about ten seconds, so callers only ever
 * get the cache; `refresh` fills it in the background, one read at a time.
 */
export class QuotaService {
  readonly #ports: QuotaPorts;
  #view: QuotaView = { accounts: [], tokens: {}, readAt: null, stale: false };
  #readAtMs: number | null = null;
  #attemptAtMs: number | null = null;
  #running: Promise<void> | null = null;
  /** The last live probe that succeeded, and when it happened. */
  #claudeLive: { windows: ClaudeUsageWindows; atMs: number } | null = null;
  /** Earliest clock time the next probe may run; null while none has failed. */
  #claudeRetryAtMs: number | null = null;
  #claudeFailures = 0;

  constructor(ports: QuotaPorts) {
    this.#ports = ports;
  }

  snapshot(): QuotaView {
    return {
      ...this.#view,
      tokens: { ...this.#view.tokens },
      accounts: this.#view.accounts.map((account) => ({ ...account, windows: [...account.windows] })),
    };
  }

  /** Starts a read unless the last attempt is newer than `maxAgeMs`. Never waits for it. */
  refreshIfOlder(maxAgeMs: number): void {
    const last = this.#attemptAtMs;
    if (last !== null && this.#ports.nowMs() - last < maxAgeMs) return;
    void this.refresh();
  }

  refresh(): Promise<void> {
    this.#running ??= this.#read().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #read(): Promise<void> {
    this.#attemptAtMs = this.#ports.nowMs();
    try {
      const parsed = parseMagpieAccounts(await this.#ports.read());
      if (parsed === null) throw new Error("magpie 输出无法解析");
      // The live probe replaces Claude's numbers outright: it is what Claude Code's own
      // /usage panel shows, and magpie's copy can be days behind when no request runs
      // through Anthropic. Anything failing here only skips that account, never the read.
      const claudeProbe = await this.#probeClaudeLive();
      // Token spans are an optional extra: a failing read leaves the last copy.
      // Promise.resolve() keeps a synchronous throw in the port inside the same catch.
      const tokens = await Promise.resolve()
        .then(() => this.#ports.readTokens())
        .then((text) => parseUsageLog(text, TOKEN_AGENTS.map(({ name }) => name), tokenWindowCutoffs(this.#ports.nowMs())))
        .catch(() => null);
      const now = this.#ports.nowMs();
      const readAt = new Date(now).toISOString();
      let fresh: QuotaAccount[] = parsed
        .filter((account) => account.windows.length > 0)
        .map((account) => {
          // When magpie last read these itself matters more than when we asked: magpie
          // caches, so numbers can be true hours ago while the command just ran.
          const readMs = account.asOf === null ? now : Date.parse(account.asOf);
          const { asOf: _asOf, ...rest } = account;
          return {
            ...rest,
            readAt: new Date(Math.min(readMs, now)).toISOString(),
            stale: readMs < now - QUOTA_STALE_MS,
          };
        });
      if (claudeProbe !== null) {
        fresh = fresh.map((account) => (account.agent === "claude" ? claudeAccount(account, claudeProbe.windows, claudeProbe.atMs, now) : account));
      }
      // One subscription failing to answer must not wipe its numbers: keep the last good ones a while.
      const kept = this.#view.accounts
        .filter((old) => !fresh.some((account) => account.id === old.id))
        .filter((old) => now - Date.parse(old.readAt) < QUOTA_KEEP_MS)
        .map((old) => ({ ...old, stale: true }));
      this.#view = {
        accounts: [...fresh, ...kept],
        tokens: this.#viewTokens(tokens),
        readAt,
        stale: false,
      };
      this.#readAtMs = now;
    } catch {
      this.#view = { ...this.#view, stale: this.#readAtMs !== null };
    }
  }

  /**
   * The last live Claude probe, probed afresh only when the interval and any backoff
   * allow. A failure never wipes the previous probe; it only delays the next one.
   */
  async #probeClaudeLive(): Promise<{ windows: ClaudeUsageWindows; atMs: number } | null> {
    const now = this.#ports.nowMs();
    const cached = this.#claudeLive;
    if (this.#claudeRetryAtMs !== null && now < this.#claudeRetryAtMs) return cached;
    if (cached !== null && now - cached.atMs < CLAUDE_LIVE_MIN_INTERVAL_MS) return cached;
    try {
      const windows = await this.#ports.readClaudeLive();
      this.#claudeLive = { windows, atMs: this.#ports.nowMs() };
      this.#claudeFailures = 0;
      this.#claudeRetryAtMs = null;
    } catch (error) {
      this.#claudeFailures += 1;
      // The server's Retry-After wins; otherwise double the wait per failure, up to an hour.
      const wait = error instanceof ClaudeUsageError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : CLAUDE_LIVE_BACKOFF_MS * 2 ** Math.min(this.#claudeFailures - 1, 4);
      this.#claudeRetryAtMs = this.#ports.nowMs() + Math.min(wait, CLAUDE_LIVE_BACKOFF_MAX_MS);
    }
    return this.#claudeLive;
  }

  /** Maps the log's agents onto their card; unmapped ones drop out, a failed read keeps the last copy. */
  #viewTokens(parsed: Record<string, QuotaTokenUsage> | null): Record<string, QuotaTokenUsage> {
    if (parsed === null) return this.#view.tokens;
    const out: Record<string, QuotaTokenUsage> = {};
    for (const { name, agent } of TOKEN_AGENTS) {
      const tokens = parsed[name];
      if (tokens) out[agent] = tokens;
    }
    return out;
  }
}

/** magpie's cached copy of a Claude account, replaced by the live probe when it answers. */
function claudeAccount(account: QuotaAccount, live: ClaudeUsageWindows, probeAtMs: number, nowMs: number): QuotaAccount {
  const windows: QuotaAccount["windows"] = [];
  if (live.fiveHour !== null) windows.push({ name: "5 hours", used: live.fiveHour, resetsAt: null });
  const weekly = account.windows.find((window) => window.name === "7 days");
  if (live.sevenDay !== null) {
    windows.push({ name: "7 days", used: live.sevenDay, resetsAt: weekly?.resetsAt ?? null });
  }
  for (const [name, used] of Object.entries(live.models)) {
    if (name === "seven_day_oauth_apps") continue;
    windows.push({ name: windowName(name), used, resetsAt: weekly?.resetsAt ?? null });
  }
  if (windows.length === 0) return account;
  // The numbers are as fresh as the probe was, not as this read: while the probe is in
  // rate-limit backoff the panel keeps showing it, honestly marked by its own age.
  const readMs = Math.min(probeAtMs, nowMs);
  return { ...account, windows, readAt: new Date(readMs).toISOString(), stale: readMs < nowMs - QUOTA_STALE_MS };
}

/** "seven_day_opus" → "7 days · Opus"; unknown suffixes keep their raw name. */
function windowName(key: string): string {
  const model = /^seven_day_([a-z_]+)$/u.exec(key)?.[1];
  if (model === undefined) return key;
  const label = model
    .split("_")
    .map((word) => (word === "" ? word : `${word[0]?.toUpperCase()}${word.slice(1)}`))
    .join("");
  return `7 days · ${label}`;
}
