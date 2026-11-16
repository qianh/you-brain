import { parseMagpieAccounts } from "./parse.js";
import type { QuotaView } from "./types.js";

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
    return { ...this.#view, accounts: this.#view.accounts.map((account) => ({ ...account })) };
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
      const accounts = parseMagpieAccounts(await this.#ports.read());
      if (accounts === null) throw new Error("magpie 输出无法解析");
      this.#readAtMs = this.#ports.nowMs();
      this.#view = { accounts, readAt: new Date(this.#readAtMs).toISOString(), stale: false };
    } catch {
      this.#view = { ...this.#view, stale: this.#readAtMs !== null };
    }
  }
}
