import { google } from "googleapis";

import {
  applyGoogleConnection,
  connectGoogleAccount,
  createConfigSecretStore,
  createOAuthClientSecretStore,
  GoogleOAuth,
  type DriveIdentityClient,
  type GoogleOAuthOptions,
  type SecretStore,
} from "../auth/index.js";
import { writeLocalConfig, type LocalConfig } from "../domain/index.js";
import { GoogleDrive } from "../drive/google-drive.js";
import type { DrivePort } from "../drive/drive-port.js";

export interface OpenGoogleDriveOptions {
  local: LocalConfig;
  configFile: string;
  platform: NodeJS.Platform;
  interactive: boolean;
  clientSecret?: string;
  secrets?: SecretStore;
}

/**
 * Open Drive with stored credentials. Interactive false returns null when
 * the user has not logged in, so the HTTP API can still start.
 */
export async function openGoogleDrive(
  options: OpenGoogleDriveOptions,
): Promise<{ drive: DrivePort; config: LocalConfig } | null> {
  const secrets =
    options.secrets ??
    createConfigSecretStore({
      platform: options.platform,
      configFile: options.configFile,
    });
  const oauthOptions: GoogleOAuthOptions =
    options.local.oauth.mode === "custom"
      ? {
          mode: "custom",
          clientId: options.local.oauth.clientId,
          clientSecret: options.clientSecret ?? null,
          clientSecretStore: createOAuthClientSecretStore({
            platform: options.platform,
            configFile: options.configFile,
          }),
        }
      : { mode: "official" };
  try {
    const oauth = new GoogleOAuth(oauthOptions, secrets);
    const client = await oauth.getClient({ interactive: options.interactive });
    const gdrive = google.drive({ version: "v3", auth: client });
    let config = options.local;
    if (!config.driveRootId) {
      const connection = await connectGoogleAccount({
        authClient: client,
        drive: () => gdrive as unknown as DriveIdentityClient,
        rootFolderName: config.driveRoot,
        ...(config.driveRootId ? { rootFolderId: config.driveRootId } : {}),
      });
      config = applyGoogleConnection(config, connection);
      await writeLocalConfig(options.configFile, config);
    }
    if (!config.driveRootId) return null;
    return {
      drive: new GoogleDrive({ client: gdrive, rootFolderId: config.driveRootId }),
      config,
    };
  } catch {
    return null;
  }
}
