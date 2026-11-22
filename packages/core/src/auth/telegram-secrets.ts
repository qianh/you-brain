import { YOU_BRAIN_KEYCHAIN_SERVICE, type CommandRunner } from "./platform-secrets.js";
import { createNamedSecretStore, type SecretBackend } from "./secret-store-factory.js";
import type { MemoryKeychain, SecretStore } from "./secret-store.js";

export const TELEGRAM_KEYCHAIN_SERVICE = `${YOU_BRAIN_KEYCHAIN_SERVICE}/telegram`;

export interface TelegramSecretOptions {
  platform: NodeJS.Platform;
  runner?: CommandRunner;
  memory?: MemoryKeychain;
  backend?: SecretBackend;
}

/** 指挥台 Telegram 桥的 Bot Token。 */
export function telegramTokenStore(options: TelegramSecretOptions): SecretStore {
  return createNamedSecretStore({
    platform: options.platform,
    service: TELEGRAM_KEYCHAIN_SERVICE,
    account: "bot-token",
    label: "you-brain Telegram bot token",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  });
}

/** Telegram 中转的设备连接密钥（与中转部署时的 RELAY_KEY 一致）。 */
export function telegramRelayKeyStore(options: TelegramSecretOptions): SecretStore {
  return createNamedSecretStore({
    platform: options.platform,
    service: TELEGRAM_KEYCHAIN_SERVICE,
    account: "relay-key",
    label: "you-brain Telegram relay key",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  });
}

/** Telegram 中转入网后的设备专属令牌。 */
export function telegramRelayTokenStore(options: TelegramSecretOptions): SecretStore {
  return createNamedSecretStore({
    platform: options.platform,
    service: TELEGRAM_KEYCHAIN_SERVICE,
    account: "relay-token",
    label: "you-brain Telegram relay token",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  });
}

/** 跨设备派活的 Ed25519 私钥。 */
export function dispatchIdentityStore(options: TelegramSecretOptions): SecretStore {
  return createNamedSecretStore({
    platform: options.platform,
    service: TELEGRAM_KEYCHAIN_SERVICE,
    account: "dispatch-identity",
    label: "you-brain dispatch identity",
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
  });
}
