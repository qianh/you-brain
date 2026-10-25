import { consolidationView } from "../../lib/copy.js";
import { isTimeOfDay } from "../settings/logic.js";

export type PortraitEmptyCopy =
  /** Daily consolidation is off, so nothing will be written until it is turned on. */
  | { kind: "off" }
  /** Consolidation is on and its time is known. */
  | { kind: "scheduled"; time: string }
  /** Status or time is unknown. Keep the original copy. */
  | { kind: "default" };

export function portraitEmptyCopy(input: {
  consolidation: Parameters<typeof consolidationView>[0];
  time: string | null | undefined;
}): PortraitEmptyCopy {
  const view = consolidationView(input.consolidation);
  if (view === "disabled") return { kind: "off" };
  const time = (input.time ?? "").trim();
  if (view !== "unknown" && isTimeOfDay(time)) return { kind: "scheduled", time };
  return { kind: "default" };
}

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
