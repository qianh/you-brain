import type { LocalConfig } from "../domain/config.js";
import type { GoogleDriveAccount } from "./google-account.js";
import {
  RELOGIN_REQUIRED_MESSAGE,
  isInvalidGrant,
  refreshTokenNeedsRelogin,
} from "./google-oauth.js";

export type GoogleAccountStatus =
  | {
      authenticated: false;
      reason: "missing_credential" | "invalid_credential" | "relogin_required";
      message?: string;
      configuredAccount?: { email: string; displayName: string };
      drive: DriveStatus;
    }
  | {
      authenticated: true;
      account: { email: string; displayName: string };
      configuredAccount?: { email: string; displayName: string };
      identityMatches: boolean;
      drive: DriveStatus;
    };

interface DriveStatus {
  configured: boolean;
  rootFolderId?: string;
  rootFolderName: string;
}

function configuredAccount(config: LocalConfig) {
  if (!config.account.email || !config.account.displayName) return undefined;
  return {
    email: config.account.email,
    displayName: config.account.displayName,
  };
}

function driveStatus(config: LocalConfig): DriveStatus {
  return {
    configured: Boolean(config.driveRootId),
    ...(config.driveRootId ? { rootFolderId: config.driveRootId } : {}),
    rootFolderName: config.driveRoot,
  };
}

export async function resolveGoogleAccountStatus(options: {
  config: LocalConfig;
  credential: string | null;
  loadAccount: () => Promise<GoogleDriveAccount>;
  now?: number;
}): Promise<GoogleAccountStatus> {
  const configured = configuredAccount(options.config);
  const drive = driveStatus(options.config);
  const base = {
    ...(configured ? { configuredAccount: configured } : {}),
    drive,
  };
  if (!options.credential) {
    return { authenticated: false, reason: "missing_credential", ...base };
  }
  if (
    refreshTokenNeedsRelogin(
      options.credential,
      options.config.oauth.mode,
      options.now ?? Date.now(),
    )
  ) {
    return {
      authenticated: false,
      reason: "relogin_required",
      message: RELOGIN_REQUIRED_MESSAGE,
      ...base,
    };
  }
  try {
    const account = await options.loadAccount();
    return {
      authenticated: true,
      account: { email: account.email, displayName: account.displayName },
      identityMatches:
        Boolean(options.config.account.permissionId) &&
        options.config.account.permissionId === account.permissionId,
      ...base,
    };
  } catch (error) {
    if (isInvalidGrant(error)) {
      return {
        authenticated: false,
        reason: "relogin_required",
        message: RELOGIN_REQUIRED_MESSAGE,
        ...base,
      };
    }
    return { authenticated: false, reason: "invalid_credential", ...base };
  }
}

export async function resolveReusableGoogleAccount(
  options: Parameters<typeof resolveGoogleAccountStatus>[0],
): Promise<{ email: string } | null> {
  const status = await resolveGoogleAccountStatus(options);
  if (!status.authenticated || !status.identityMatches || !status.drive.configured) {
    return null;
  }
  return { email: status.account.email };
}
