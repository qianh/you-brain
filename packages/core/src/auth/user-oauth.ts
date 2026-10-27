import type { LocalConfig } from "../domain/config.js";
import { YouBrainError } from "../domain/errors.js";
import type { SecretStore } from "./secret-store.js";

/** Google 的 OAuth client id 一定是这个后缀。写错时提前拦住，不要等到授权页报错。 */
export const GOOGLE_CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

export function isGoogleClientId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.endsWith(GOOGLE_CLIENT_ID_SUFFIX) && trimmed.length > GOOGLE_CLIENT_ID_SUFFIX.length;
}

export async function saveUserOAuthCredentials(options: {
  config: LocalConfig;
  clientId: string;
  clientSecret: string;
  secrets: SecretStore;
}): Promise<LocalConfig> {
  const clientId = options.clientId.trim();
  const clientSecret = options.clientSecret.trim();
  if (!clientId || !clientSecret) {
    throw new YouBrainError(
      "INVALID_INPUT",
      "OAuth client id and client secret are required",
    );
  }
  if (!isGoogleClientId(clientId)) {
    throw new YouBrainError(
      "INVALID_INPUT",
      `OAuth client id 必须以 ${GOOGLE_CLIENT_ID_SUFFIX} 结尾，收到 ${clientId}`,
    );
  }
  await options.secrets.set(clientSecret);
  return {
    ...options.config,
    oauth: { mode: "custom", clientId },
  };
}

/**
 * 只换 client id，沿用已存的 client secret。界面上改 id 时不必重新粘贴 secret。
 * 没有已存 secret 时报错，调用方要退回完整的 `saveUserOAuthCredentials`。
 */
export async function updateUserOAuthClientId(options: {
  config: LocalConfig;
  clientId: string;
  secrets: SecretStore;
}): Promise<LocalConfig> {
  const clientId = options.clientId.trim();
  if (!isGoogleClientId(clientId)) {
    throw new YouBrainError(
      "INVALID_INPUT",
      `OAuth client id 必须以 ${GOOGLE_CLIENT_ID_SUFFIX} 结尾，收到 ${clientId}`,
    );
  }
  const existing = await options.secrets.get();
  if (!existing?.trim()) {
    throw new YouBrainError("INVALID_INPUT", "还没有保存过 client secret，请一起填写");
  }
  return {
    ...options.config,
    oauth: { mode: "custom", clientId },
  };
}

export async function clearUserOAuthCredentials(options: {
  config: LocalConfig;
  secrets: SecretStore;
}): Promise<LocalConfig> {
  await options.secrets.delete();
  return {
    ...options.config,
    oauth: { mode: "official", clientId: "" },
  };
}
