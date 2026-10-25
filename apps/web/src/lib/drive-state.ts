export type DriveState = "checking" | "signedOut" | "offline" | "connected";

export interface DriveInput {
  reachable: boolean | null;
  /** Missing, null, or blank all mean no signed-in account. */
  accountEmail?: string | null;
}

/** The account email with blanks trimmed. An empty string means no signed-in account. */
export function driveEmail(drive: { accountEmail?: string | null } | null | undefined): string {
  const value = drive?.accountEmail;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * One state for every Drive surface. A missing or unknown reachability is
 * `checking`, never a failure. Reachable is connected whatever the email says.
 */
export function driveState(drive: DriveInput | null | undefined): DriveState {
  if (!drive || typeof drive.reachable !== "boolean") return "checking";
  if (drive.reachable) return "connected";
  return driveEmail(drive) === "" ? "signedOut" : "offline";
}

/** A signed-out Drive needs a login row, unless the daemon already reports one. */
export function needsDriveLogin(state: DriveState, warnings: readonly { code: string }[]): boolean {
  if (state !== "signedOut") return false;
  return !warnings.some((warning) => {
    const code = warning.code.trim().toUpperCase();
    return code === "AUTH_REQUIRED" || code.includes("DRIVE");
  });
}

/** True while a loaded status still reports the Drive check as unfinished. */
export function driveStillChecking(status: { drive: DriveInput } | null | undefined): boolean {
  return status != null && driveState(status.drive) === "checking";
}
