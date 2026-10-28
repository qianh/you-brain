import {
  createNamedSecretStore,
  type SecretBackend,
} from "./secret-store-factory.js";
import { YOU_BRAIN_KEYCHAIN_SERVICE } from "./platform-secrets.js";
import type { MemoryKeychain, SecretStore } from "./secret-store.js";
import type { CommandRunner } from "./platform-secrets.js";

export const NOTION_KEYCHAIN_SERVICE = `${YOU_BRAIN_KEYCHAIN_SERVICE}/notion`;

export interface NotionSecretOptions {
  platform: NodeJS.Platform;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
  backend?: SecretBackend;
  store?: SecretStore;
}

function storeFor(options: NotionSecretOptions): SecretStore {
  if (options.store) return options.store;
  return createNamedSecretStore({
    platform: options.platform,
    service: NOTION_KEYCHAIN_SERVICE,
    account: "token",
    label: "you-brain Notion integration token",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  });
}

export async function getNotionToken(options: NotionSecretOptions): Promise<string | null> {
  const value = await storeFor(options).get();
  return value?.trim() ? value : null;
}

export async function setNotionToken(
  token: string,
  options: NotionSecretOptions,
): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Notion token is empty");
  await storeFor(options).set(trimmed);
}
