import { google } from "googleapis";

import {
  MISSING_OFFICIAL_OAUTH_MESSAGE,
  applyGoogleConnection,
  connectGoogleAccount,
  createConfigSecretStore,
  createOAuthClientSecretStore,
  fillMissingAccount,
  GoogleOAuth,
  isInvalidGrant,
  type DriveIdentityClient,
  type GoogleOAuthOptions,
  type SecretBackend,
  type SecretStore,
} from "../auth/index.js";
import { YouBrainError, writeLocalConfig, type LocalConfig } from "../domain/index.js";
import { GoogleDrive } from "../drive/google-drive.js";
import type { DrivePort } from "../drive/drive-port.js";

export interface OpenGoogleDriveOptions {
  local: LocalConfig;
  configFile: string;
  platform: NodeJS.Platform;
  interactive: boolean;
  clientSecret?: string;
  secrets?: SecretStore;
  /** 文件密钥后端。不传时走系统钥匙串。 */
  secretBackend?: SecretBackend;
  /** 无界面服务器：固定回调端口、打印 SSH 隧道命令、不拉起浏览器。 */
  headless?: {
    port?: number;
    describeTunnel?: (port: number) => string | null;
    onAuthorizationUrl?: (info: { url: string; tunnel: string | null }) => void;
  };
  /** Passed through when resolving the official OAuth client. */
  env?: NodeJS.ProcessEnv;
  /** Aborting cancels an interactive login that is waiting for the browser. */
  signal?: AbortSignal;
}

const DRIVE_REQUEST_TIMEOUT_MS = 120_000;

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && typeof current.code === "string") codes.push(current.code);
    current = "cause" in current ? current.cause : undefined;
  }
  return codes;
}

function isNetworkFailure(codes: string[], message: string): boolean {
  if (codes.some((code) => NETWORK_CODES.has(code))) return true;
  return /getaddrinfo|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|fetch failed|socket hang up/iu.test(
    message,
  );
}

/** User-facing reason for an interactive Google login failure. */
export function describeGoogleDriveOpenError(error: unknown): string {
  const message = errorText(error);
  const codes = errorCodes(error);
  if (
    message.includes("未内置官方 OAuth 凭据") ||
    message.includes("Official Google OAuth client is missing")
  ) {
    return MISSING_OFFICIAL_OAUTH_MESSAGE;
  }
  if (
    message === "Google 登录已取消" ||
    /OAuth authorization was cancelled/iu.test(message) ||
    /access_denied/u.test(message)
  ) {
    return "Google 登录已取消";
  }
  if (/OAuth callback timed out/iu.test(message) || message === "Google 登录等待超时，请重试") {
    return "Google 登录等待超时，请重试";
  }
  if (
    codes.includes("EADDRINUSE") ||
    message.includes("EADDRINUSE") ||
    message.includes("本地授权端口被占用") ||
    // 无界面固定端口的新文案（headless-oauth.ts）。
    message.includes("被占用")
  ) {
    return message.includes("端口")
      ? message
      : "本地授权端口被占用，请关闭占用 127.0.0.1 的程序后重试";
  }
  if (/OAuth callback validation failed/u.test(message) || message.includes("回调校验失败")) {
    return "Google 登录回调校验失败";
  }
  if (isInvalidGrant(error) || message.includes("invalid_grant")) {
    return "Google 授权无效（invalid_grant），请重新登录";
  }
  if (message.includes("did not return a refresh token") || message.includes("未返回 refresh token")) {
    return "Google 未返回 refresh token，请在授权页重新同意后重试";
  }
  if (isNetworkFailure(codes, message)) {
    return `连接 Google 失败：${message || codes.join(",")}`;
  }
  if (message.startsWith("Google 登录失败：") || message.startsWith("连接 Google 失败：")) {
    return message;
  }
  if (message) return `Google 登录失败：${message}`;
  return "Google 登录未完成";
}

/**
 * Open Drive with stored credentials. Interactive false returns null when
 * login is unavailable, so the HTTP API can still start. Interactive
 * failures throw a specific reason.
 */
export async function openGoogleDrive(
  options: OpenGoogleDriveOptions,
): Promise<{ drive: DrivePort; config: LocalConfig } | null> {
  const secrets =
    options.secrets ??
    createConfigSecretStore({
      platform: options.platform,
      configFile: options.configFile,
      ...(options.secretBackend ? { backend: options.secretBackend } : {}),
    });
  const official: GoogleOAuthOptions = {
    mode: "official",
    ...(options.env ? { env: options.env } : {}),
    ...(options.headless ? { headless: options.headless } : {}),
  };
  const oauthOptions: GoogleOAuthOptions =
    options.local.oauth.mode === "custom"
      ? {
          mode: "custom",
          clientId: options.local.oauth.clientId,
          clientSecret: options.clientSecret ?? null,
          clientSecretStore: createOAuthClientSecretStore({
            platform: options.platform,
            configFile: options.configFile,
            ...(options.secretBackend ? { backend: options.secretBackend } : {}),
          }),
          ...(options.headless ? { headless: options.headless } : {}),
        }
      : official;
  try {
    const oauth = new GoogleOAuth(oauthOptions, secrets);
    const client = await oauth.getClient({
      interactive: options.interactive,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // Without a timeout one stalled request holds the daemon's whole work queue.
    const gdrive = google.drive({ version: "v3", auth: client, timeout: DRIVE_REQUEST_TIMEOUT_MS });
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
    if (!config.driveRootId) {
      if (!options.interactive) return null;
      throw new YouBrainError("DRIVE_ROOT_REQUIRED", "Google 登录失败：未能确定 Drive 根目录");
    }
    const filled = await fillMissingAccount(config, gdrive as unknown as DriveIdentityClient);
    if (filled) {
      config = filled;
      await writeLocalConfig(options.configFile, config);
    }
    return {
      drive: new GoogleDrive({ client: gdrive, rootFolderId: config.driveRootId }),
      config,
    };
  } catch (error) {
    if (!options.interactive) return null;
    const code = error instanceof YouBrainError ? error.code : "AUTH_REQUIRED";
    throw new YouBrainError(code, describeGoogleDriveOpenError(error));
  }
}
