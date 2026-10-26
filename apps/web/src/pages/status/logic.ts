import { readCaptures } from "../../lib/copy.js";
import { driveState, type DriveInput } from "../../lib/drive-state.js";

export type HeroKind = "loading" | "ok" | "warn" | "danger";
export type HeroFault = "refine" | "sync" | "drive";
export type WarningAction = "model" | "sync" | "login" | "none";
export type StatusScreen = "loading" | "offline" | "error" | "ready";
export type DotTone = "ok" | "warn" | "bad" | "muted";

export interface WebSessionLineInput {
  isLocalProcessor: boolean;
  pending: number;
}

export type WebSessionLine =
  | { visible: false }
  | { visible: true; kind: "pending"; count: number }
  | { visible: true; kind: "done" };

/** The status row is only for the device that refines web sessions. */
export function webSessionLine(web: WebSessionLineInput | null | undefined): WebSessionLine {
  if (!web?.isLocalProcessor) return { visible: false };
  if (!Number.isFinite(web.pending) || web.pending <= 0) return { visible: true, kind: "done" };
  return { visible: true, kind: "pending", count: Math.floor(web.pending) };
}

export interface HeroInput {
  loading: boolean;
  hasStatus: boolean;
  driveReachable: boolean | null;
  /** Needed to tell an offline drive (a failure) from a signed-out one (a warning). */
  driveEmail?: string | null;
  refineError: string | null;
  /** An explicit sync failure. Never-synced and a pending outbox are not one. */
  syncError?: string | null;
  warningCount: number;
}

const SOURCE_ORDER = ["claude-code", "codex", "grok-build", "cursor", "gemini-cli", "pi", "t3-code"] as const;

export function heroKind(input: HeroInput): HeroKind {
  if (!input.hasStatus || input.loading) {
    // A refresh keeps the last snapshot on screen. Loading only replaces it
    // when there is nothing to show yet.
    if (!input.hasStatus) return "loading";
  }
  if ((input.refineError ?? "").trim() !== "") return "danger";
  // Signed out is a warning: the login row is counted in warningCount.
  if (driveState({ reachable: input.driveReachable, accountEmail: input.driveEmail ?? null }) === "offline") {
    return "danger";
  }
  if ((input.syncError ?? "").trim() !== "") return "danger";
  if (input.warningCount > 0) return "warn";
  return "ok";
}

/** Which danger the hero names. Refine and sync errors win. An offline Drive is named only when nothing else failed. */
export function heroFault(input: HeroInput): HeroFault | null {
  if (heroKind(input) !== "danger") return null;
  if ((input.refineError ?? "").trim() !== "") return "refine";
  if ((input.syncError ?? "").trim() !== "") return "sync";
  if (driveState({ reachable: input.driveReachable, accountEmail: input.driveEmail ?? null }) === "offline") {
    return "drive";
  }
  return "sync";
}

export function warningAction(code: string): WarningAction {
  const normalized = code.trim().toUpperCase().replace(/[\s-]+/gu, "_");
  if (normalized === "") return "none";
  if (normalized.startsWith("LLM_")) return "model";
  if (normalized === "AUTH_REQUIRED" || normalized.startsWith("DRIVE_") || normalized.includes("DRIVE")) {
    return "login";
  }
  if (normalized.startsWith("SYNC_") || normalized.startsWith("INDEX_") || normalized.startsWith("SEARCH_")) {
    return "sync";
  }
  return "none";
}

export interface AttentionItem {
  key: string;
  code: string;
  message: string;
  action: WarningAction;
}

export function attentionItems(
  warnings: readonly { code: string; message: string }[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  for (const warning of warnings) {
    const message = warning.message.trim();
    if (message === "") continue;
    const code = warning.code.trim();
    const key = `${code}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, code, message, action: warningAction(code) });
  }
  return items;
}

/** A signed-out Drive gets a login row, unless the daemon already reports one (see needsDriveLogin). */
export function withDriveSignedOutWarning(
  warnings: readonly { code: string; message: string }[],
  needsLogin: boolean,
  message: string,
): { code: string; message: string }[] {
  if (!needsLogin || message.trim() === "") return [...warnings];
  return [...warnings, { code: "DRIVE_SIGNED_OUT", message }];
}

/** A stale consolidation that the daemon did not already emit still needs a row. */
export function withConsolidationWarning(
  warnings: readonly { code: string; message: string }[],
  stale: boolean,
  message: string,
): { code: string; message: string }[] {
  if (!stale || message.trim() === "") return [...warnings];
  const listed = warnings.some((warning) => warning.code.trim().toUpperCase() === "CONSOLIDATION_STALE");
  if (listed) return [...warnings];
  return [...warnings, { code: "CONSOLIDATION_STALE", message }];
}

export function isUnreachableError(message: string | null): boolean {
  if (message === null || message.trim() === "") return false;
  return /failed to fetch|load failed|networkerror|network error|无法连接|连不上|不是 json|invalid_response|daemon_unreachable|econnrefused|fetch failed|socket hang up/iu.test(
    message,
  );
}

export function statusScreen(input: {
  loading: boolean;
  hasStatus: boolean;
  error: string | null;
}): StatusScreen {
  if (input.hasStatus) return "ready";
  if (input.loading) return "loading";
  if (input.error && !isUnreachableError(input.error)) return "error";
  return "offline";
}

export interface SyncLineInput {
  lastSyncAt?: string | null;
  pendingOutbox?: number;
  lastError?: string | null;
  lastErrorAt?: string | null;
}

export interface SyncLine {
  /** `bad` is a failed pull. `muted` is never synced. `ok` is a successful sync time. */
  tone: "bad" | "muted" | "ok";
  message: string | null;
  at: string | null;
}

/** The status sync row. A backlog does not change the tone. */
export function syncLine(sync: SyncLineInput | null | undefined): SyncLine {
  const message = typeof sync?.lastError === "string" ? sync.lastError.trim() : "";
  if (message !== "") {
    const at = typeof sync?.lastErrorAt === "string" ? sync.lastErrorAt.trim() : "";
    return { tone: "bad", message, at: at === "" ? null : at };
  }
  const at = typeof sync?.lastSyncAt === "string" ? sync.lastSyncAt.trim() : "";
  if (at === "") return { tone: "muted", message: null, at: null };
  return { tone: "ok", message: null, at };
}

export function driveTone(drive: DriveInput | null | undefined): DotTone {
  const state = driveState(drive);
  if (state === "connected") return "ok";
  if (state === "offline") return "bad";
  if (state === "signedOut") return "warn";
  return "muted";
}

export function refineTone(pending: number, lastError: string | null): DotTone {
  if ((lastError ?? "").trim() !== "") return "bad";
  if (pending > 0) return "warn";
  return "ok";
}

export function searchTone(ready: boolean, documents = 0): DotTone {
  if (ready) return "ok";
  // A built index that is not ready is the stale case, not an empty one.
  if (documents > 0) return "warn";
  return "muted";
}

/** Drop log lines that already appear as warnings, so the log is not a second copy. */
export function logsBesideWarnings(
  logs: readonly { at: string | null; message: string }[],
  warnings: readonly { message: string }[],
): { at: string | null; message: string }[] {
  const messages = new Set(warnings.map((warning) => warning.message.trim()).filter((message) => message !== ""));
  return logs.filter((row) => {
    const message = row.message.trim();
    return message !== "" && !messages.has(message);
  });
}

export interface CaptureView {
  source: string;
  lastCaptureAt: string | null;
  error: string | null;
  count: number | null;
  enabled: boolean;
}

export function captureTone(row: Pick<CaptureView, "error" | "lastCaptureAt" | "enabled">): DotTone {
  if (row.error) return "bad";
  if (!row.enabled || row.lastCaptureAt === null) return "muted";
  return "ok";
}

function readCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function readCaptureCounts(payload: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (payload === null || typeof payload !== "object" || !("captures" in payload)) return counts;
  const value = payload.captures;
  if (!Array.isArray(value)) return counts;
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const source = "source" in item && typeof item.source === "string" ? item.source.trim() : "";
    if (source === "") continue;
    const record = item as Record<string, unknown>;
    const count = readCount(record.sessionCount) ?? readCount(record.sessions) ?? readCount(record.count);
    if (count !== null) counts.set(source, count);
  }
  return counts;
}

/** Known sources first, then any extra row the daemon reported. Counts stay optional. */
export function captureViews(
  payload: unknown,
  enabled: Readonly<Record<string, boolean>> | null,
): CaptureView[] {
  const rows = readCaptures(payload);
  const counts = readCaptureCounts(payload);
  const bySource = new Map(rows.map((row) => [row.source, row]));
  const order: string[] = [];
  const seen = new Set<string>();
  const base = enabled ? Object.keys(enabled) : [...SOURCE_ORDER];
  for (const source of [...base, ...rows.map((row) => row.source)]) {
    if (source.trim() === "" || seen.has(source)) continue;
    seen.add(source);
    order.push(source);
  }
  return order.map((source) => {
    const row = bySource.get(source);
    return {
      source,
      lastCaptureAt: row?.lastCaptureAt ?? null,
      error: row?.error ?? null,
      count: counts.get(source) ?? null,
      enabled: enabled?.[source] !== false,
    };
  });
}
