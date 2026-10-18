import type { Language } from "./format.js";
import { translate, type MessageKey } from "../i18n/messages.js";

export interface CaptureFlag {
  keepToolCalls: boolean;
  includeSubagents: boolean;
  redact: boolean;
}

export function uncollectedNotes(flags: CaptureFlag, language: Language): string[] {
  return [
    translate(language, "noteSystem"),
    translate(language, flags.keepToolCalls ? "noteToolsKept" : "noteToolsDropped"),
    translate(language, flags.includeSubagents ? "noteSubagentsKept" : "noteSubagentsDropped"),
    translate(language, flags.redact ? "noteRedactOn" : "noteRedactOff"),
  ];
}

const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

export interface SettingsDraft {
  idleMinutes: number;
  activeLimit: number;
  historyDays: number;
  morningDigestTime: string;
  weeklyReviewTime: string;
  consolidateTime: string;
  timezone: string;
  driveRoot: string;
  baseUrl: string;
  variants: readonly { id: string; path: string }[];
}

function positiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function knownZone(timeZone: string): boolean {
  if (timeZone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function httpUrlOrEmpty(value: string): boolean {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateSettings(draft: SettingsDraft): MessageKey[] {
  const issues: MessageKey[] = [];
  if (!positiveInt(draft.idleMinutes)) issues.push("invalidIdle");
  if (!positiveInt(draft.activeLimit)) issues.push("invalidLimit");
  if (!positiveInt(draft.historyDays)) issues.push("invalidHistory");
  if (!TIME_OF_DAY.test(draft.morningDigestTime)) issues.push("invalidTime");
  if (!TIME_OF_DAY.test(draft.weeklyReviewTime)) issues.push("invalidTime");
  if (!TIME_OF_DAY.test(draft.consolidateTime)) issues.push("invalidTime");
  if (!knownZone(draft.timezone)) issues.push("invalidZone");
  if (draft.driveRoot.trim() === "") issues.push("invalidRoot");
  if (!httpUrlOrEmpty(draft.baseUrl.trim())) issues.push("invalidBase");
  const variantsOk = draft.variants.every(
    (variant) => variant.id.trim() !== "" && variant.path.trim() !== "",
  );
  if (!variantsOk || draft.variants.length === 0) issues.push("invalidVariant");
  return issues;
}

export function linesToList(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function listToLines(values: readonly string[]): string {
  return values.join("\n");
}

export interface PanelStatusInput {
  drive: { reachable: boolean | null };
  refine: { lastError: string | null };
  consolidation: { stale: boolean };
  warnings: readonly { message: string }[];
}

export type Attention = "ok" | "warn" | "bad";

export function panelProblems(status: PanelStatusInput, language: Language): string[] {
  const problems: string[] = [];
  if (status.drive.reachable === false) problems.push(translate(language, "driveDown"));
  if (status.consolidation.stale) problems.push(translate(language, "consolidationStale"));
  if (status.refine.lastError) problems.push(status.refine.lastError);
  for (const warning of status.warnings) {
    if (warning.message.trim() !== "") problems.push(warning.message);
  }
  return problems;
}

export function attentionLevel(status: PanelStatusInput, problems: readonly string[]): Attention {
  if (status.drive.reachable === false) return "bad";
  if (status.refine.lastError) return "bad";
  if (problems.length > 0 || status.consolidation.stale) return "warn";
  return "ok";
}

export interface CaptureRow {
  source: string;
  lastCaptureAt: string | null;
  error: string | null;
}

export interface LogRow {
  at: string | null;
  message: string;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function readCaptures(payload: unknown): CaptureRow[] {
  if (payload === null || typeof payload !== "object" || !("captures" in payload)) return [];
  const value = payload.captures;
  if (!Array.isArray(value)) return [];
  const rows: CaptureRow[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const source = "source" in item ? readString(item.source) : null;
    if (source === null) continue;
    const lastCaptureAt = "lastCaptureAt" in item ? readString(item.lastCaptureAt) : null;
    const error = "error" in item ? readString(item.error) : null;
    rows.push({ source, lastCaptureAt, error });
  }
  return rows;
}

export function readLogs(payload: unknown): LogRow[] {
  if (payload === null || typeof payload !== "object" || !("logs" in payload)) return [];
  const value = payload.logs;
  if (!Array.isArray(value)) return [];
  const rows: LogRow[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const message = "message" in item ? readString(item.message) : null;
    if (message === null) continue;
    const at = "at" in item ? readString(item.at) : null;
    rows.push({ at, message });
  }
  return rows;
}

export interface SearchNoticeInput {
  indexStatus: "fresh" | "stale";
  searchMode: "semantic" | "keyword";
  warnings: readonly { code: string; message: string }[];
}

export interface SearchNotice {
  tone: "warn" | "info";
  text: string;
}

export function searchNotices(input: SearchNoticeInput, language: Language): SearchNotice[] {
  const notices: SearchNotice[] = [];
  if (input.indexStatus === "stale") {
    notices.push({ tone: "warn", text: translate(language, "searchStale") });
  }
  if (input.searchMode === "keyword") {
    notices.push({ tone: "warn", text: translate(language, "searchKeyword") });
  }
  for (const warning of input.warnings) {
    if (warning.message.trim() === "") continue;
    notices.push({ tone: "info", text: warning.message });
  }
  return notices;
}

export function searchTitle(hit: {
  excerpt: string;
  source: string;
  conversationId: string;
}): string {
  const line = hit.excerpt
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line !== undefined && line.length > 0 && line.length < hit.excerpt.trim().length && line.length <= 80) {
    return line;
  }
  const id = hit.conversationId.slice(0, 8);
  const label = hit.source.trim() === "" ? "session" : hit.source;
  return `${label} · ${id}`;
}

export function kindLabel(kind: string, language: Language): string {
  if (kind === "server") return translate(language, "kindServer");
  if (kind === "virtual") return translate(language, "kindVirtual");
  return translate(language, "kindDesktop");
}

export function platformLabel(platform: string, language: Language): string {
  if (platform === "linux") return translate(language, "platformLinux");
  if (platform === "bot") return translate(language, "platformBot");
  return translate(language, "platformDarwin");
}

export function capabilityLabel(capability: string, language: Language): string {
  if (capability === "refine") return translate(language, "capRefine");
  if (capability === "consolidate") return translate(language, "capConsolidate");
  return translate(language, "capCapture");
}
