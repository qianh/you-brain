import { YOU_BRAIN_KEYCHAIN_SERVICE, type CommandRunner } from "./platform-secrets.js";
import { createNamedSecretStore, type SecretBackend } from "./secret-store-factory.js";
import type { MemoryKeychain, SecretStore } from "./secret-store.js";

/** 指挥台（DSH）可选的第三方搜索后端；Key 与 LLM 供应商分开存。 */
export const SEARCH_PROVIDERS = ["exa", "tavily"] as const;

export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

export function searchKeychainService(provider: SearchProvider): string {
  return `${YOU_BRAIN_KEYCHAIN_SERVICE}/search/${provider}`;
}

export interface SearchSecretOptions {
  platform: NodeJS.Platform;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
  backend?: SecretBackend;
  store?: SecretStore;
}

function storeFor(provider: SearchProvider, options: SearchSecretOptions): SecretStore {
  if (options.store) return options.store;
  return createNamedSecretStore({
    platform: options.platform,
    service: searchKeychainService(provider),
    account: "api-key",
    label: `you-brain ${provider} search API key`,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  });
}

export async function getSearchKey(
  provider: SearchProvider,
  options: SearchSecretOptions,
): Promise<string | null> {
  const value = await storeFor(provider, options).get();
  return value?.trim() ? value.trim() : null;
}

export async function setSearchKey(
  provider: SearchProvider,
  apiKey: string,
  options: SearchSecretOptions,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("search API key is empty");
  await storeFor(provider, options).set(trimmed);
}
