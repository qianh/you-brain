import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { LlmProvider } from "@you-brain/protocol";
import { LlmProviderSchema } from "@you-brain/protocol";

import {
  PlatformSecretStore,
  YOU_BRAIN_KEYCHAIN_SERVICE,
  type CommandRunner,
} from "./platform-secrets.js";
import {
  MemoryKeychain,
  MigratingSecretStore,
  type SecretStore,
} from "./secret-store.js";

export interface NamedSecretOptions {
  platform: NodeJS.Platform;
  service?: string;
  account: string;
  label?: string;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
}

export function credentialStoreAccount(configFile: string): string {
  const digest = createHash("sha256")
    .update(resolve(configFile))
    .digest("hex")
    .slice(0, 32);
  return `config-${digest}`;
}

export function oauthClientSecretAccount(configFile: string): string {
  return `oauth-client-secret:${credentialStoreAccount(configFile).slice("config-".length)}`;
}

export function llmKeychainService(provider: LlmProvider): string {
  return `${YOU_BRAIN_KEYCHAIN_SERVICE}/llm/${provider}`;
}

export function llmKeychainKey(provider: LlmProvider): string {
  return llmKeychainService(provider);
}

export const LLM_KEYCHAIN_ACCOUNT = "api-key";

export function createNamedSecretStore(options: NamedSecretOptions): SecretStore {
  const service = options.service ?? YOU_BRAIN_KEYCHAIN_SERVICE;
  if (options.memory) return options.memory.store(service, options.account);
  return new PlatformSecretStore({
    platform: options.platform,
    service,
    account: options.account,
    ...(options.label ? { label: options.label } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
  });
}

export interface ConfigSecretStoreOptions {
  platform: NodeJS.Platform;
  configFile: string;
  legacyAccount?: string;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
}

export function createConfigSecretStore(
  options: ConfigSecretStoreOptions,
): SecretStore {
  const account = credentialStoreAccount(options.configFile);
  const primary = createNamedSecretStore({
    platform: options.platform,
    account,
    label: "you-brain Google OAuth",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
  });
  if (!options.legacyAccount) return primary;
  const legacy = createNamedSecretStore({
    platform: options.platform,
    account: options.legacyAccount,
    label: "you-brain Google OAuth",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
  });
  return new MigratingSecretStore(primary, legacy);
}

export function createOAuthClientSecretStore(
  options: ConfigSecretStoreOptions,
): SecretStore {
  return createNamedSecretStore({
    platform: options.platform,
    account: oauthClientSecretAccount(options.configFile),
    label: "you-brain OAuth client secret",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
  });
}

export function createLlmSecretStore(options: {
  platform: NodeJS.Platform;
  provider: LlmProvider | string;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
}): SecretStore {
  const provider = LlmProviderSchema.parse(options.provider);
  return createNamedSecretStore({
    platform: options.platform,
    service: llmKeychainService(provider),
    account: LLM_KEYCHAIN_ACCOUNT,
    label: `you-brain ${provider} API key`,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
  });
}
