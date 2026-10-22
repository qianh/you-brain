export function countReadingChars(source: string): number {
  const compact = source.replace(/\s+/gu, "");
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(compact)].length;
}

export function formatReadingCount(count: number, language: "zh" | "en"): string {
  return new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US").format(count);
}

export async function writeClipboard(text: string, write: (value: string) => Promise<void>): Promise<boolean> {
  try {
    await write(text);
    return true;
  } catch {
    return false;
  }
}

/** Version token from a snapshot file name. The full name stays in a tooltip. */
export function snapshotVersion(name: string): string {
  const match = /(?:^|[^A-Za-z0-9])(v\d+(?:\.\d+)*)(?=[^A-Za-z0-9]|$)/iu.exec(name);
  if (match?.[1]) return match[1];
  const bare = name.replace(/\.md$/iu, "").trim();
  return bare === "" ? name : bare;
}

export function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
