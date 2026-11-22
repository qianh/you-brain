import { derivePublicKey, generateKeyPair, signCommand, signTunnelTranscript, type CommandSigningFields } from "@you-brain/protocol";

import type { SecretStore } from "../auth/secret-store.js";

export interface DeviceIdentityOptions {
  store: SecretStore;
}

export interface DeviceKeyPair {
  publicKey: string;
  privateKey: string;
}

/**
 * 本机派活身份（Ed25519 密钥对）。
 * 只把私钥存进 SecretStore，公钥每次从私钥推导，不另存；已存密钥损坏时拒绝覆盖并抛错。
 */
export class DeviceIdentity {
  readonly #store: SecretStore;
  #cached: DeviceKeyPair | null = null;
  #loading: Promise<DeviceKeyPair> | null = null;

  constructor(options: DeviceIdentityOptions) {
    this.#store = options.store;
  }

  async ensure(): Promise<DeviceKeyPair> {
    if (this.#cached) return { ...this.#cached };
    if (this.#loading) return { ...(await this.#loading) };
    const task = this.#loadOrCreate();
    this.#loading = task;
    try {
      const pair = await task;
      this.#cached = pair;
      return { ...pair };
    } finally {
      if (this.#loading === task) this.#loading = null;
    }
  }

  async publicKey(): Promise<string> {
    return (await this.ensure()).publicKey;
  }

  async sign(frame: CommandSigningFields): Promise<string> {
    const { privateKey } = await this.ensure();
    try {
      return signCommand(privateKey, frame);
    } catch {
      throw new Error("使用本机派活私钥签名失败");
    }
  }

  /** 对 T3 隧道握手记录签名，让对端确认这条隧道确实通到本机。 */
  async signTranscript(transcript: string): Promise<string> {
    const { privateKey } = await this.ensure();
    try {
      return signTunnelTranscript(privateKey, transcript);
    } catch {
      throw new Error("使用本机派活私钥签名失败");
    }
  }

  async #loadOrCreate(): Promise<DeviceKeyPair> {
    const existing = await this.#store.get();
    if (existing !== null) {
      const privateKey = existing.trim();
      try {
        const publicKey = derivePublicKey(privateKey);
        return { publicKey, privateKey };
      } catch {
        throw new Error("本机派活密钥已损坏，无法解析；已停止使用且未覆盖原值，请检查或重置钥匙串中的派活密钥后重新入网");
      }
    }
    const generated = generateKeyPair();
    await this.#store.set(generated.privateKey);
    return generated;
  }
}
