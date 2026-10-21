export type ListKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** Move a highlighted row. `current` may be -1 before anything is highlighted. */
export function nextIndex(current: number, count: number, key: ListKey): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (current < 0) return key === "ArrowUp" ? count - 1 : 0;
  const delta = key === "ArrowDown" ? 1 : -1;
  return (current + delta + count) % count;
}

/** First-letter / prefix jump, starting at `start` and wrapping once. */
export function typeaheadIndex(labels: readonly string[], buffer: string, start: number): number {
  const query = buffer.trim().toLocaleLowerCase();
  if (query === "" || labels.length === 0) return -1;
  const origin = start < 0 ? 0 : start % labels.length;
  for (let step = 0; step < labels.length; step += 1) {
    const index = (origin + step) % labels.length;
    const label = labels[index] ?? "";
    if (label.toLocaleLowerCase().startsWith(query)) return index;
  }
  return -1;
}
