export type CapsuleKind = "offline" | "loading" | "refine-error" | "sync-error" | "warn" | "ok";

export interface CapsuleInput {
  /** The daemon answered. A failed first load is offline; stale data stays connected. */
  connected: boolean;
  /** A sync, or the first load, is in flight. */
  syncing: boolean;
  driveReachable: boolean | null;
  refineError: string | null;
  /** An explicit sync failure. "Never synced" is not one. */
  syncError: string | null;
  warningCount: number;
}

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface CapsuleStatus {
  drive: { reachable: boolean | null };
  refine: { lastError: string | null };
  sync: { lastError?: string | null };
  warnings: readonly unknown[];
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
    refineError: status?.refine.lastError ?? null,
    syncError: status?.sync.lastError ?? null,
    warningCount: status?.warnings.length ?? 0,
  });
}

/**
 * offline > loading > refine error > sync error > warnings > ok.
 * `driveReachable === null` is unknown, not a sync failure.
 */
export function capsuleKind(input: CapsuleInput): CapsuleKind {
  if (!input.connected) return "offline";
  if (input.syncing) return "loading";
  if (text(input.refineError) !== "") return "refine-error";
  if (text(input.syncError) !== "" || input.driveReachable === false) return "sync-error";
  if (input.warningCount > 0) return "warn";
  return "ok";
}
