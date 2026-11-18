import type { ReferenceCandidateView, ReferenceKind } from "@you-brain/core/http/types.js";

import { nextIndex } from "../lib/list-nav.js";
import type { ShortcutMod } from "../lib/shortcuts.js";

export const REFERENCE_KIND_ORDER: readonly ReferenceKind[] = ["tty7", "session", "topic", "kb"];

export interface ReferenceGroup {
  kind: ReferenceKind;
  items: ReferenceCandidateView[];
}

export function groupReferenceCandidates(candidates: readonly ReferenceCandidateView[]): ReferenceGroup[] {
  const byKind = new Map<ReferenceKind, ReferenceCandidateView[]>();
  for (const candidate of candidates) {
    const bucket = byKind.get(candidate.kind);
    if (bucket) bucket.push(candidate);
    else byKind.set(candidate.kind, [candidate]);
  }
  const groups: ReferenceGroup[] = [];
  for (const kind of REFERENCE_KIND_ORDER) {
    const items = byKind.get(kind);
    if (items && items.length > 0) groups.push({ kind, items });
  }
  return groups;
}

export function flattenReferenceGroups(groups: readonly ReferenceGroup[]): ReferenceCandidateView[] {
  return groups.flatMap((group) => group.items);
}

export function moveReferenceSelection(current: number, total: number, direction: 1 | -1): number {
  return nextIndex(current, total, direction === 1 ? "ArrowDown" : "ArrowUp");
}

export function isReferenceShortcut(
  event: { key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean },
  mod: ShortcutMod,
): boolean {
  if (event.alt || !event.shift) return false;
  const modDown = mod === "meta" ? event.meta && !event.ctrl : event.ctrl && !event.meta;
  if (!modDown) return false;
  return event.key === "2" || event.key === "@";
}
