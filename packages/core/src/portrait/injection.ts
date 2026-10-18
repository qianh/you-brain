import type { CaptureSourceId } from "@you-brain/protocol";

import {
  CLIENT_CATALOG,
  portraitBody,
} from "../clients/catalog.js";
import {
  applyClientIntegrations,
  planClientIntegrations,
} from "../clients/integrations.js";
import type { PortraitConsentStore } from "./consent.js";

export interface InjectionSyncResult {
  updated: boolean;
  applied: string[];
  skipped: string[];
}

export function codingInjectionFingerprint(codingPath: string): string {
  const wordings = CLIENT_CATALOG.map(
    (client) => `${client.id}\t${portraitBody(client)}`,
  ).join("\n");
  return `${codingPath}\n${wordings}`;
}

function isClientId(value: string): value is CaptureSourceId {
  return CLIENT_CATALOG.some((client) => client.id === value);
}

export function portraitConsentIds(ids: readonly string[]): string[] {
  const unique: string[] = [];
  for (const id of ids) {
    if (!id.endsWith(":portrait")) continue;
    const clientId = id.slice(0, -":portrait".length);
    if (!isClientId(clientId) || unique.includes(id)) continue;
    unique.push(id);
  }
  return unique;
}

function mergeConsentIds(existing: readonly string[], portraitIds: readonly string[]): string[] {
  const kept = existing.filter((id) => !id.endsWith(":portrait") && !portraitIds.includes(id));
  return [...kept, ...portraitIds];
}

function clientIds(itemIds: readonly string[]): CaptureSourceId[] {
  const ids: CaptureSourceId[] = [];
  for (const itemId of itemIds) {
    const clientId = itemId.slice(0, -":portrait".length);
    if (isClientId(clientId) && !ids.includes(clientId)) ids.push(clientId);
  }
  return ids;
}

export class CodingInjection {
  readonly #homeDir: string;
  readonly #managedStatePath: string;
  readonly #consent: PortraitConsentStore;
  readonly #codingPath: () => string;

  constructor(options: {
    homeDir: string;
    managedStatePath: string;
    consent: PortraitConsentStore;
    codingPath: () => string;
  }) {
    this.#homeDir = options.homeDir;
    this.#managedStatePath = options.managedStatePath;
    this.#consent = options.consent;
    this.#codingPath = options.codingPath;
  }

  async applyConsented(itemIds: readonly string[]): Promise<InjectionSyncResult> {
    const current = await this.#consent.load();
    const consented = portraitConsentIds(itemIds);
    const result = await this.#apply(consented);
    await this.#consent.save({
      itemIds: mergeConsentIds(current.itemIds, consented),
      fingerprint: codingInjectionFingerprint(this.#codingPath()),
    });
    return { updated: true, applied: result.applied, skipped: result.skipped };
  }

  /**
   * Rewrite managed blocks for every consented portrait client.
   * Unlike reconcile(), this runs on daemon start even when the fingerprint
   * is missing or already matches. A missing client directory is retried next time.
   */
  async ensureApplied(): Promise<InjectionSyncResult> {
    const consent = await this.#consent.load();
    const consented = portraitConsentIds(consent.itemIds);
    if (consented.length === 0) return { updated: false, applied: [], skipped: [] };
    const result = await this.#apply(consented);
    if (result.missing.length === 0) {
      await this.#consent.save({
        itemIds: mergeConsentIds(consent.itemIds, consented),
        fingerprint: codingInjectionFingerprint(this.#codingPath()),
      });
    }
    return { updated: true, applied: result.applied, skipped: result.skipped };
  }

  async reconcile(): Promise<InjectionSyncResult> {
    const consent = await this.#consent.load();
    const consented = portraitConsentIds(consent.itemIds);
    if (consented.length === 0 || consent.fingerprint === null) {
      return { updated: false, applied: [], skipped: [] };
    }
    const fingerprint = codingInjectionFingerprint(this.#codingPath());
    if (consent.fingerprint === fingerprint) {
      return { updated: false, applied: [], skipped: [] };
    }
    const result = await this.#apply(consented);
    if (result.missing.length === 0) {
      await this.#consent.save({
        itemIds: mergeConsentIds(consent.itemIds, consented),
        fingerprint,
      });
    }
    return { updated: true, applied: result.applied, skipped: result.skipped };
  }

  async #apply(consented: readonly string[]): Promise<{
    applied: string[];
    skipped: string[];
    missing: string[];
  }> {
    if (consented.length === 0) return { applied: [], skipped: [], missing: [] };
    const plan = await planClientIntegrations({
      homeDir: this.#homeDir,
      managedStatePath: this.#managedStatePath,
      intent: "install",
      clients: clientIds(consented),
    });
    const present = new Set(plan.items.map((item) => item.id));
    const missing = consented.filter((id) => !present.has(id));
    const selected = consented.filter((id) =>
      plan.items.some((item) => item.id === id && item.kind === "portrait"),
    );
    const result = await applyClientIntegrations({
      homeDir: this.#homeDir,
      plan,
      selectedIds: selected,
      managedStatePath: this.#managedStatePath,
    });
    return { applied: result.applied, skipped: result.skipped, missing };
  }
}
