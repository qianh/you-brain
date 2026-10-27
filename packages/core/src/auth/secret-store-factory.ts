import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import type { LlmProvider } from "@you-brain/protocol";
import { LlmProviderSchema } from "@you-brain/protocol";

import type { DeviceRole } from "../domain/config.js";
import { FileSecretStore } from "./file-secrets.js";
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

export interface SecretBackend {
  /** 设置时用文件后端，否则用系统钥匙串。 */
  file?: string;
}

export const SECRET_BACKEND_ENV = "YOU_BRAIN_SECRET_BACKEND";
export const SECRETS_FILE_ENV = "YOU_BRAIN_SECRETS_FILE";
export const DEFAULT_SECRETS_FILE = "secrets.json";

/**
 * 选择密钥后端。
 *
 * 默认是系统钥匙串。无界面服务器上没有 Secret Service，`secret-tool` 不可用，
 * 所以服务器模式默认改用文件后端：写到数据目录下的 `secrets.json`（0600）。
 * 也可以显式指定：`YOU_BRAIN_SECRET_BACKEND=file`，或者用
 * `YOU_BRAIN_SECRETS_FILE` 指定别的路径（两者都优先于角色默认）。
 */
export function resolveSecretBackend(input: {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  role?: DeviceRole;
}): SecretBackend {
  const explicit = input.env[SECRETS_FILE_ENV]?.trim();
  if (explicit) return { file: explicit };
  const mode = input.env[SECRET_BACKEND_ENV]?.trim().toLowerCase();
  if (mode === "file") return { file: join(input.dataDir, DEFAULT_SECRETS_FILE) };
  if (mode === "keychain") return {};
  if (input.role === "server") return { file: join(input.dataDir, DEFAULT_SECRETS_FILE) };
  return {};
}

export interface NamedSecretOptions {
  platform: NodeJS.Platform;
  service?: string;
  account: string;
  label?: string;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
  backend?: SecretBackend;
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
  if (options.backend?.file) {
    return new FileSecretStore(service, options.account, { path: options.backend.file });
  }
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
  backend?: SecretBackend;
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
    ...(options.backend ? { backend: options.backend } : {}),
  });
  if (!options.legacyAccount) return primary;
  const legacy = createNamedSecretStore({
    platform: options.platform,
    account: options.legacyAccount,
    label: "you-brain Google OAuth",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
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
    ...(options.backend ? { backend: options.backend } : {}),
  });
}

export function createLlmSecretStore(options: {
  platform: NodeJS.Platform;
  provider: LlmProvider | string;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
  backend?: SecretBackend;
}): SecretStore {
  const provider = LlmProviderSchema.parse(options.provider);
  return createNamedSecretStore({
    platform: options.platform,
    service: llmKeychainService(provider),
    account: LLM_KEYCHAIN_ACCOUNT,
    label: `you-brain ${provider} API key`,
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  });
}
