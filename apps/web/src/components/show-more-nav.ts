import type { ListKey } from "../lib/list-nav.js";

/** How many items stay mounted. Expanded, or a short list, keeps every row. */
export function shownCount(total: number, limit: number, open: boolean): number {
  if (total <= 0) return 0;
  if (open || total <= limit) return total;
  return limit;
}

/** Index of the first row that appears only after expand. `null` when nothing is folded. */
export function firstRevealedIndex(limit: number, total: number): number | null {
  if (total <= limit) return null;
  return limit;
}

/**
 * Collapsing unmounts rows at `index >= limit`. If focus is inside one of them,
 * move it to the toggle first; otherwise leave focus where it is.
 */
export function collapseFocusTarget(activeIndex: number, limit: number): "toggle" | "keep" {
  if (!Number.isFinite(activeIndex) || activeIndex < limit) return "keep";
  return "toggle";
}

/**
 * Count rows that precede the toggle. `positionFlags` are `row.compareDocumentPosition(toggle)`
 * results; a row precedes the toggle when `followingBit` is set.
 */
export function rowsBeforeToggle(positionFlags: readonly number[], followingBit: number): number {
  let count = 0;
  for (const flag of positionFlags) {
    if ((flag & followingBit) !== 0) count += 1;
  }
  return count;
}

/**
 * Synthetic index so ↑↓ treat the toggle as sitting between the rows before it
 * and the rows after it. `nextIndex` moves by one, so the two directions need
 * different anchors.
 */
export function toggleAnchorIndex(rowsBefore: number, key: ListKey): number {
  if (key === "Home" || key === "End") return -1;
  if (key === "ArrowDown") return rowsBefore - 1;
  return rowsBefore;
}

const FOCUSABLE = [
  "[data-session-row]",
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function previousElementSiblings(button: HTMLElement): HTMLElement[] {
  const siblings: HTMLElement[] = [];
  let node = button.previousElementSibling;
  while (node) {
    if (node instanceof HTMLElement) siblings.push(node);
    node = node.previousElementSibling;
  }
  siblings.reverse();
  return siblings;
}

export function focusableInside(root: HTMLElement): HTMLElement | null {
  if (root.matches(FOCUSABLE)) return root;
  return root.querySelector<HTMLElement>(FOCUSABLE);
}

/** Index of the sibling that contains `active`, or -1 when focus is not in a preceding row. */
export function hostIndexBefore(button: HTMLElement, active: Node): number {
  let host: Node | null = active;
  while (host !== null && host.parentElement !== button.parentElement) host = host.parentElement;
  if (!(host instanceof HTMLElement) || host === button) return -1;
  return previousElementSiblings(button).indexOf(host);
}
