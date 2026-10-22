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

export function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
