import { join } from "node:path";

import type { CaptureSourceId } from "@you-brain/protocol";

import {
  CLIENT_CATALOG,
  portraitBody,
} from "../clients/catalog.js";
import {
  applyClientIntegrations,
  planClientIntegrations,
  planClientUninstall,
} from "../clients/integrations.js";
import { readTextIfPresent } from "../clients/mcp-config.js";
import type { PortraitConsentStore } from "./consent.js";

export interface InjectionSyncResult {
  updated: boolean;
  applied: string[];
  skipped: string[];
}

export function codingInjectionFingerprint(
  codingPath: string,
  codingMarkdown?: string | null,
): string {
  const wordings = CLIENT_CATALOG.map(
    (client) => `${client.id}\t${portraitBody(client, codingMarkdown)}`,
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
  readonly #codingFilePath: string;

  constructor(options: {
    homeDir: string;
    managedStatePath: string;
    consent: PortraitConsentStore;
    codingPath: () => string;
    codingFilePath?: string;
  }) {
    this.#homeDir = options.homeDir;
    this.#managedStatePath = options.managedStatePath;
    this.#consent = options.consent;
    this.#codingPath = options.codingPath;
    this.#codingFilePath =
      options.codingFilePath ?? join(options.homeDir, ".you-brain", "portrait", "coding.md");
  }

  async #currentFingerprint(): Promise<string> {
    const codingMarkdown = await readTextIfPresent(this.#codingFilePath);
    return codingInjectionFingerprint(this.#codingPath(), codingMarkdown);
  }

  async applyConsented(itemIds: readonly string[]): Promise<InjectionSyncResult> {
    const current = await this.#consent.load();
    const consented = portraitConsentIds(itemIds);
    const result = await this.#apply(consented);
    await this.#consent.save({
      itemIds: mergeConsentIds(current.itemIds, consented),
      fingerprint: await this.#currentFingerprint(),
    });
    return { updated: true, applied: result.applied, skipped: result.skipped };
  }

  /**
   * Sync Web Settings `codingPortraitClients` toggles with managed CLI blocks:
   * installs inline coding rules + owned skills for checked clients, and removes
   * managed blocks from unchecked clients.
   */
  async syncSelectedClients(clients: readonly string[]): Promise<InjectionSyncResult> {
    const current = await this.#consent.load();
    const previous = portraitConsentIds(current.itemIds);
    const next = portraitConsentIds(clients.map((id) => `${id}:portrait`));
    const removed = previous.filter((id) => !next.includes(id));

    const applied: string[] = [];
    const skipped: string[] = [];

    if (removed.length > 0) {
      const uninstallPlan = await planClientUninstall({
        homeDir: this.#homeDir,
        managedStatePath: this.#managedStatePath,
        clients: clientIds(removed),
        codingFilePath: this.#codingFilePath,
      });
      const uninstallSelected = removed.filter((id) =>
        uninstallPlan.items.some((item) => item.id === id && item.kind === "portrait"),
      );
      if (uninstallSelected.length > 0) {
        const res = await applyClientIntegrations({
          homeDir: this.#homeDir,
          plan: uninstallPlan,
          selectedIds: uninstallSelected,
          managedStatePath: this.#managedStatePath,
          codingFilePath: this.#codingFilePath,
        });
        applied.push(...res.applied);
        skipped.push(...res.skipped);
      }
    }

    if (next.length > 0) {
      const installRes = await this.#apply(next, true);
      applied.push(...installRes.applied);
      skipped.push(...installRes.skipped);
    }

    await this.#consent.save({
      itemIds: mergeConsentIds(current.itemIds, next),
      fingerprint: next.length > 0 ? await this.#currentFingerprint() : null,
    });
    return { updated: applied.length > 0 || removed.length > 0, applied, skipped };
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
    const result = await this.#apply(consented, true);
    if (result.missing.length === 0) {
      await this.#consent.save({
        itemIds: mergeConsentIds(consent.itemIds, consented),
        fingerprint: await this.#currentFingerprint(),
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
    const fingerprint = await this.#currentFingerprint();
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

  async #apply(
    consented: readonly string[],
    includeSkills = false,
  ): Promise<{
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
      codingFilePath: this.#codingFilePath,
    });
    const present = new Set(plan.items.map((item) => item.id));
    const missing = consented.filter((id) => !present.has(id));
    const selected = plan.items
      .filter(
        (item) =>
          (item.kind === "portrait" && consented.includes(item.id)) ||
          (includeSkills && item.kind === "skill"),
      )
      .map((item) => item.id);
    const result = await applyClientIntegrations({
      homeDir: this.#homeDir,
      plan,
      selectedIds: selected,
      managedStatePath: this.#managedStatePath,
      codingFilePath: this.#codingFilePath,
    });
    return { applied: result.applied, skipped: result.skipped, missing };
  }
}
