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

export interface DeferredClipboard {
  write?: (items: ClipboardItem[]) => Promise<void>;
  writeText: (text: string) => Promise<void>;
}

/**
 * 把稍后才拿到的文本写入剪贴板。必须在用户点击的同一调用栈里同步调用：
 * WebKit 要求写剪贴板时仍在用户手势有效期内，先 await 接口再 writeText 会被拒（NotAllowedError）。
 * 有 ClipboardItem 时把 Promise 直接交给它，浏览器会在 Promise 完成后写入；否则退回 writeText。
 */
export function writeClipboardDeferred(
  text: Promise<string>,
  clipboard: DeferredClipboard,
  makeItem: ((data: Record<string, Promise<Blob>>) => ClipboardItem) | null =
    typeof ClipboardItem === "undefined" ? null : (data) => new ClipboardItem(data),
): Promise<boolean> {
  try {
    if (makeItem !== null && clipboard.write !== undefined) {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
      return clipboard.write([makeItem({ "text/plain": blob })]).then(
        () => true,
        () => false,
      );
    }
  } catch {
    // 构造 ClipboardItem 或调用 write 同步抛错时退回 writeText。
  }
  return text.then((value) => clipboard.writeText(value)).then(
    () => true,
    () => false,
  );
}
