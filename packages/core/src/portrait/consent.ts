import { readFile } from "node:fs/promises";

import { writeFileAtomic } from "../domain/atomic.js";
import { YouBrainError } from "../domain/errors.js";

export interface PortraitConsent {
  /** Integration plan item ids the user agreed to, for example `claude-code:portrait`. */
  itemIds: string[];
  /** Coding path plus instruction wording at the last successful apply. Null before that. */
  fingerprint: string | null;
}

export interface PortraitConsentStore {
  load(): Promise<PortraitConsent>;
  save(consent: PortraitConsent): Promise<void>;
}

export function emptyPortraitConsent(): PortraitConsent {
  return { itemIds: [], fingerprint: null };
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export class FilePortraitConsentStore implements PortraitConsentStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<PortraitConsent> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isEnoent(error)) return emptyPortraitConsent();
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as Partial<PortraitConsent>;
      const itemIds = Array.isArray(parsed.itemIds)
        ? parsed.itemIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [];
      const fingerprint = typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
      return { itemIds, fingerprint };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid portrait consent";
      throw new YouBrainError("CONFIG_INVALID", message);
    }
  }

  async save(consent: PortraitConsent): Promise<void> {
    const body = {
      itemIds: [...consent.itemIds],
      fingerprint: consent.fingerprint,
    };
    await writeFileAtomic(this.#path, `${JSON.stringify(body, null, 2)}\n`);
  }
}

export class MemoryPortraitConsentStore implements PortraitConsentStore {
  #consent: PortraitConsent = emptyPortraitConsent();

  async load(): Promise<PortraitConsent> {
    return {
      itemIds: [...this.#consent.itemIds],
      fingerprint: this.#consent.fingerprint,
    };
  }

  async save(consent: PortraitConsent): Promise<void> {
    this.#consent = {
      itemIds: [...consent.itemIds],
      fingerprint: consent.fingerprint,
    };
  }
}
