import type { LlmProvider } from "@you-brain/protocol";
import { LlmProviderSchema } from "@you-brain/protocol";

import {
  LLM_KEYCHAIN_ACCOUNT,
  createLlmSecretStore,
  llmKeychainKey,
  llmKeychainService,
} from "./secret-store-factory.js";
import type { MemoryKeychain, SecretStore } from "./secret-store.js";
import type { CommandRunner } from "./platform-secrets.js";

export { LLM_KEYCHAIN_ACCOUNT, llmKeychainKey, llmKeychainService };

export interface LlmSecretOptions {
  platform: NodeJS.Platform;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
  storeFor?: (provider: LlmProvider) => SecretStore;
}

function storeFor(provider: LlmProvider, options: LlmSecretOptions): SecretStore {
  if (options.storeFor) return options.storeFor(provider);
  return createLlmSecretStore({
    platform: options.platform,
    provider,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
  });
}

export async function getLlmApiKey(
  provider: LlmProvider | string,
  options: LlmSecretOptions,
): Promise<string | null> {
  const parsed = LlmProviderSchema.parse(provider);
  const value = await storeFor(parsed, options).get();
  return value?.trim() ? value : null;
}

export async function setLlmApiKey(
  provider: LlmProvider | string,
  apiKey: string,
  options: LlmSecretOptions,
): Promise<void> {
  const parsed = LlmProviderSchema.parse(provider);
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("API key is empty");
  await storeFor(parsed, options).set(trimmed);
}

export async function deleteLlmApiKey(
  provider: LlmProvider | string,
  options: LlmSecretOptions,
): Promise<void> {
  const parsed = LlmProviderSchema.parse(provider);
  await storeFor(parsed, options).delete();
}
