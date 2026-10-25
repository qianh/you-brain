import { driveState, needsDriveLogin } from "./drive-state.js";

export type CapsuleKind = "offline" | "loading" | "refine-error" | "sync-error" | "warn" | "ok";

export interface CapsuleInput {
  /** The daemon answered. A failed first load is offline; stale data stays connected. */
  connected: boolean;
  /** A sync, or the first load, is in flight. */
  syncing: boolean;
  driveReachable: boolean | null;
  /** Only an offline drive (signed in, unreachable) is a failure. A signed-out drive is a warning. */
  driveEmail?: string | null;
  refineError: string | null;
  /** An explicit sync failure. "Never synced" is not one. */
  syncError: string | null;
  warningCount: number;
}

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface CapsuleStatus {
  drive: { reachable: boolean | null; accountEmail?: string | null };
  refine: { lastError: string | null };
  sync: { lastError?: string | null };
  warnings: readonly { code: string }[];
}

/** Warnings the capsule counts: the daemon's list, plus a signed-out Drive that has no login row yet. */
export function capsuleWarningCount(status: CapsuleStatus | null): number {
  if (!status) return 0;
  const state = driveState({ reachable: status.drive.reachable, accountEmail: status.drive.accountEmail ?? null });
  return status.warnings.length + (needsDriveLogin(state, status.warnings) ? 1 : 0);
}

/** Shared by the shell and the panel. A backlog is not part of this input. */
export function capsuleFromStatus(
  status: CapsuleStatus | null,
  flags: { connected: boolean; syncing: boolean },
): CapsuleKind {
  return capsuleKind({
    connected: flags.connected,
    syncing: flags.syncing,
    driveReachable: status?.drive.reachable ?? null,
    driveEmail: status?.drive.accountEmail ?? null,
    refineError: status?.refine.lastError ?? null,
    syncError: status?.sync.lastError ?? null,
    warningCount: capsuleWarningCount(status),
  });
}

/**
 * offline > loading > refine error > sync error > warnings > ok.
 * `driveReachable === null` is unknown, not a sync failure.
 * A signed-out drive (not reachable, no email) counts as a warning, not a sync error.
 */
export function capsuleKind(input: CapsuleInput): CapsuleKind {
  if (!input.connected) return "offline";
  if (input.syncing) return "loading";
  if (text(input.refineError) !== "") return "refine-error";
  const drive = driveState({ reachable: input.driveReachable, accountEmail: input.driveEmail ?? null });
  if (text(input.syncError) !== "" || drive === "offline") return "sync-error";
  if (input.warningCount > 0) return "warn";
  return "ok";
}
