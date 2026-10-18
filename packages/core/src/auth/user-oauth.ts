import type { LocalConfig } from "../domain/config.js";
import { YouBrainError } from "../domain/errors.js";
import type { SecretStore } from "./secret-store.js";

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
  await options.secrets.set(clientSecret);
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
