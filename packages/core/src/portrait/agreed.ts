import type { PortraitConsent, PortraitConsentStore } from "./consent.js";
import { codingInjectionFingerprint } from "./injection.js";

function union(left: readonly string[], right: readonly string[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...left, ...right]) {
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function hasPortrait(ids: readonly string[]): boolean {
  return ids.some((id) => id.endsWith(":portrait"));
}

/** Remember the items the user confirmed. Portrait ids refresh the coding fingerprint. */
export async function grantIntegrationConsent(
  store: PortraitConsentStore,
  ids: readonly string[],
  codingPath: string,
): Promise<PortraitConsent> {
  const current = await store.load();
  const itemIds = union(current.itemIds, ids);
  const next: PortraitConsent = {
    itemIds,
    fingerprint: hasPortrait(itemIds)
      ? codingInjectionFingerprint(codingPath)
      : current.fingerprint,
  };
  await store.save(next);
  return next;
}

/** Drop revoked items. Clearing the last portrait id also clears the fingerprint. */
export async function revokeIntegrationConsent(
  store: PortraitConsentStore,
  ids: readonly string[],
): Promise<PortraitConsent> {
  const current = await store.load();
  const drop = new Set(ids);
  const itemIds = current.itemIds.filter((id) => !drop.has(id));
  const next: PortraitConsent = {
    itemIds,
    fingerprint: hasPortrait(itemIds) ? current.fingerprint : null,
  };
  await store.save(next);
  return next;
}
