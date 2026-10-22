import { snapshotVersion } from "./logic.js";

export const CORRECTION_SECTION_LIMIT = 80;
export const CORRECTION_TEXT_LIMIT = 1_000;
export const CORRECTION_EXCERPT = 140;

export type CorrectionIssue = "section" | "text";

/** Trimmed JS string length, matching the HTTP check. */
export function correctionCount(value: string): number {
  return value.trim().length;
}

export function correctionFieldIssue(section: string, text: string): CorrectionIssue | null {
  const sectionLength = correctionCount(section);
  if (sectionLength < 1 || sectionLength > CORRECTION_SECTION_LIMIT) return "section";
  const textLength = correctionCount(text);
  if (textLength < 1 || textLength > CORRECTION_TEXT_LIMIT) return "text";
  return null;
}

export function correctionCanSubmit(section: string, text: string, saving: boolean): boolean {
  return !saving && correctionFieldIssue(section, text) === null;
}

/** Fail closed: only an explicit enabled flag selects the daily-merge hint. */
export function correctionHint(consolidationEnabled: boolean): "on" | "off" {
  return consolidationEnabled ? "on" : "off";
}

export function correctionAllowsForm(variant: string): boolean {
  return variant === "full";
}

export function correctionStatusParts(
  status: "pending" | "applied",
  snapshot?: string,
): { key: "pending" | "applied"; version: string } {
  if (status !== "applied") return { key: "pending", version: "" };
  const version = snapshot ? snapshotVersion(snapshot) : "";
  return { key: "applied", version };
}

export function correctionExcerpt(
  text: string,
  limit = CORRECTION_EXCERPT,
): { excerpt: string; truncated: boolean } {
  const chars = Array.from(text);
  if (chars.length <= limit) return { excerpt: text, truncated: false };
  return { excerpt: chars.slice(0, limit).join(""), truncated: true };
}
