export const SUMMARY_MAX = 200;
export const NEXT_STEP_MAX = 80;
export const REASON_MAX = 80;

export function textUnits(value: string): number {
  return Array.from(value).length;
}

export function collapseText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function sameText(left: string, right: string): boolean {
  return collapseText(left) === collapseText(right);
}

export function clipUnits(value: string, max: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("");
}
