import type { LocalConfig } from "../domain/config.js";
import { YouBrainError } from "../domain/errors.js";
import type { GoogleOAuthClient } from "./google-oauth.js";

const folderMimeType = "application/vnd.google-apps.folder";

export interface GoogleDriveAccount {
  email: string;
  displayName: string;
  permissionId: string;
}

export interface GoogleAccountConnection {
  account: GoogleDriveAccount;
  rootFolderId: string;
}

export class DriveRootConflictError extends YouBrainError {
  constructor(readonly candidates: string[]) {
    super(
      "DRIVE_ROOT_CONFLICT",
      `Multiple Drive roots exist; choose one of: ${candidates.join(", ")}`,
    );
    this.name = "DriveRootConflictError";
  }
}

export interface DriveIdentityClient {
  about: {
    get(args: {
      fields: string;
    }): Promise<{
      data: {
        user?: {
          emailAddress?: string | null;
          displayName?: string | null;
          permissionId?: string | null;
        };
      };
    }>;
  };
  files: {
    list(args: Record<string, unknown>): Promise<{
      data: { files?: Array<{ id?: string | null }> | null };
    }>;
    create(args: Record<string, unknown>): Promise<{ data: { id?: string | null } }>;
  };
}

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export async function readGoogleDriveAccount(
  client: DriveIdentityClient,
): Promise<GoogleDriveAccount> {
  const response = await client.about.get({
    fields: "user(displayName,emailAddress,permissionId)",
  });
  const email = response.data.user?.emailAddress?.trim();
  const displayName = response.data.user?.displayName?.trim();
  const permissionId = response.data.user?.permissionId?.trim();
  if (!email || !displayName || !permissionId) {
    throw new YouBrainError(
      "AUTH_ACCOUNT_UNAVAILABLE",
      "Google Drive did not return a complete account identity",
    );
  }
  return { email, displayName, permissionId };
}

export async function ensureDriveRoot(
  client: DriveIdentityClient,
  name: string,
  selectedId?: string,
): Promise<string> {
  const q = `'root' in parents and name = '${escapeQuery(name)}' and mimeType = '${folderMimeType}' and trashed = false`;
  const existing = await client.files.list({
    q,
    fields: "files(id)",
    pageSize: 1_000,
    spaces: "drive",
  });
  const candidates = (existing.data.files ?? [])
    .flatMap((file) => (file.id ? [file.id] : []))
    .sort();
  if (selectedId) {
    if (candidates.includes(selectedId)) return selectedId;
    throw new YouBrainError(
      "INVALID_INPUT",
      `Selected Drive root ${selectedId} is not a matching ${name} folder`,
    );
  }
  if (candidates.length > 1) throw new DriveRootConflictError(candidates);
  const existingId = candidates[0];
  if (existingId) return existingId;
  const created = await client.files.create({
    requestBody: { name, mimeType: folderMimeType, parents: ["root"] },
    fields: "id",
  });
  if (!created.data.id) throw new Error("Google Drive did not return a root folder ID");
  return created.data.id;
}

export async function connectGoogleAccount(options: {
  authClient: GoogleOAuthClient;
  drive: (auth: GoogleOAuthClient) => DriveIdentityClient;
  rootFolderName: string;
  rootFolderId?: string;
}): Promise<GoogleAccountConnection> {
  const client = options.drive(options.authClient);
  const account = await readGoogleDriveAccount(client);
  const rootFolderId = await ensureDriveRoot(
    client,
    options.rootFolderName,
    options.rootFolderId,
  );
  return { account, rootFolderId };
}

export function applyGoogleConnection(
  config: LocalConfig,
  connection: GoogleAccountConnection,
): LocalConfig {
  return {
    ...config,
    driveRootId: connection.rootFolderId,
    account: {
      email: connection.account.email,
      displayName: connection.account.displayName,
      permissionId: connection.account.permissionId,
    },
  };
}

export function clearGoogleConnection(config: LocalConfig): LocalConfig {
  return {
    ...config,
    driveRootId: "",
    account: { email: "", displayName: "", permissionId: "" },
  };
}
