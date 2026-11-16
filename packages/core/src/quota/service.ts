import { parseMagpieAccounts } from "./parse.js";
import type { QuotaAccount, QuotaView } from "./types.js";

/** An account whose allowance magpie could not read keeps its last numbers this long. */
export const QUOTA_KEEP_MS = 60 * 60_000;

export interface QuotaPorts {
  /** Runs `magpie accounts --json` and returns its stdout. Rejects on any failure. */
  read(): Promise<string>;
  nowMs(): number;
}

/**
 * Holds the last good quota read. A read takes about ten seconds, so callers only ever
 * get the cache; `refresh` fills it in the background, one read at a time.
 */
export class QuotaService {
  readonly #ports: QuotaPorts;
  #view: QuotaView = { accounts: [], readAt: null, stale: false };
  #readAtMs: number | null = null;
  #attemptAtMs: number | null = null;
  #running: Promise<void> | null = null;

  constructor(ports: QuotaPorts) {
    this.#ports = ports;
  }

  snapshot(): QuotaView {
    return {
      ...this.#view,
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
      const now = this.#ports.nowMs();
      const readAt = new Date(now).toISOString();
      const fresh: QuotaAccount[] = parsed
        .filter((account) => account.windows.length > 0)
        .map((account) => ({ ...account, readAt, stale: false }));
      // One subscription failing to answer must not wipe its numbers: keep the last good ones a while.
      const kept = this.#view.accounts
        .filter((old) => !fresh.some((account) => account.id === old.id))
        .filter((old) => now - Date.parse(old.readAt) < QUOTA_KEEP_MS)
        .map((old) => ({ ...old, stale: true }));
      this.#readAtMs = now;
      this.#view = { accounts: [...fresh, ...kept], readAt, stale: false };
    } catch {
      this.#view = { ...this.#view, stale: this.#readAtMs !== null };
    }
  }
}
