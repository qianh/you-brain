// Adapted from Meta's muse-gadget-sdk (Apache-2.0).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";

import { MuseProtocolError } from "./errors.js";

const EMPTY = Buffer.alloc(0);
const PUBLIC_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PRIVATE_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const sha256 = (...data: Uint8Array[]): Buffer => createHash("sha256").update(Buffer.concat(data)).digest();
const hmacSha256 = (key: Uint8Array, data: Uint8Array): Buffer =>
  createHmac("sha256", key).update(data).digest();

function hkdfPair(key: Uint8Array, input: Uint8Array): [Buffer, Buffer] {
  const temp = hmacSha256(key, input);
  const first = hmacSha256(temp, Buffer.from([1]));
  return [first, hmacSha256(temp, Buffer.concat([first, Buffer.from([2])]))];
}

export class CipherState {
  #nonce = 0n;
  #dead = false;
  readonly #key: Uint8Array | undefined;

  constructor(key?: Uint8Array) {
    this.#key = key;
  }

  #iv(): Buffer {
    if (this.#dead || this.#nonce >= 9007199254740991n) {
      throw new MuseProtocolError("Noise 加密状态不可用");
    }
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.#nonce++, 4);
    return iv;
  }

  encrypt(data: Uint8Array, ad: Uint8Array = EMPTY): Buffer {
    if (this.#dead) throw new MuseProtocolError("Noise 加密状态不可用");
    if (!this.#key) return Buffer.from(data);
    try {
      const cipher = createCipheriv("aes-256-gcm", this.#key, this.#iv());
      cipher.setAAD(ad);
      return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    } catch (error) {
      this.#dead = true;
      throw error;
    }
  }

  decrypt(data: Uint8Array, ad: Uint8Array = EMPTY): Buffer {
    if (this.#dead) throw new MuseProtocolError("Noise 解密状态不可用");
    if (!this.#key) return Buffer.from(data);
    try {
      if (data.length < 16) throw new Error("缺少认证标签");
      const cipher = createDecipheriv("aes-256-gcm", this.#key, this.#iv());
      cipher.setAAD(ad);
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]);
    } catch {
      this.#dead = true;
      throw new MuseProtocolError("Noise 消息认证失败");
    }
  }
}

function keyPair(raw?: Uint8Array): { privateKey: KeyObject; publicKey: Buffer } {
  const privateKey = raw
    ? createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, raw]), type: "pkcs8", format: "der" })
    : generateKeyPairSync("x25519").privateKey;
  return {
    privateKey,
    publicKey: createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32),
  };
}

function dh(privateKey: KeyObject, raw: Uint8Array): Buffer {
  if (raw.length !== 32) throw new MuseProtocolError("无效的 X25519 公钥");
  const publicKey = createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, raw]), type: "spki", format: "der" });
  return diffieHellman({ privateKey, publicKey });
}

export class NoiseInitiator {
  #h: Buffer = Buffer.alloc(32);
  #ck: Buffer;
  #cipher = new CipherState();
  #ephemeral: ReturnType<typeof keyPair> | undefined;
  #remoteEphemeral: Buffer | undefined;
  #phase: "new" | "message1" | "message2" | "done" | "dead" = "new";
  readonly #fixedKeys: { ephemeral: Uint8Array; static: Uint8Array } | undefined;

  constructor(fixedKeys?: { ephemeral: Uint8Array; static: Uint8Array }) {
    this.#fixedKeys = fixedKeys;
    this.#h.write("Noise_XX_25519_AESGCM_SHA256");
    this.#ck = this.#h;
    this.#mixHash(EMPTY);
  }

  #mixHash(data: Uint8Array): void {
    this.#h = sha256(this.#h, data);
  }

  #mixKey(data: Uint8Array): void {
    const [ck, key] = hkdfPair(this.#ck, data);
    this.#ck = ck;
    this.#cipher = new CipherState(key);
  }

  #encrypt(data: Uint8Array): Buffer {
    const encrypted = this.#cipher.encrypt(data, this.#h);
    this.#mixHash(encrypted);
    return encrypted;
  }

  #decrypt(data: Uint8Array): Buffer {
    const plain = this.#cipher.decrypt(data, this.#h);
    this.#mixHash(data);
    return plain;
  }

  message1(): Buffer {
    if (this.#phase !== "new") throw new MuseProtocolError("无效的 Noise 握手状态");
    this.#ephemeral = keyPair(this.#fixedKeys?.ephemeral);
    this.#mixHash(this.#ephemeral.publicKey);
    this.#encrypt(EMPTY);
    this.#phase = "message1";
    return this.#ephemeral.publicKey;
  }

  receiveMessage2(message: Buffer): void {
    if (this.#phase !== "message1") throw new MuseProtocolError("无效的 Noise 握手状态");
    this.#phase = "dead";
    if (message.length < 96) throw new MuseProtocolError("Noise 握手消息长度不足");
    const ephemeral = this.#ephemeral;
    if (!ephemeral) throw new MuseProtocolError("缺少本地临时密钥");
    this.#remoteEphemeral = message.subarray(0, 32);
    this.#mixHash(this.#remoteEphemeral);
    this.#mixKey(dh(ephemeral.privateKey, this.#remoteEphemeral));
    const remoteStatic = this.#decrypt(message.subarray(32, 80));
    this.#mixKey(dh(ephemeral.privateKey, remoteStatic));
    this.#decrypt(message.subarray(80));
    this.#phase = "message2";
  }

  finish(): { message: Buffer; send: CipherState; receive: CipherState } {
    if (this.#phase !== "message2") throw new MuseProtocolError("无效的 Noise 握手状态");
    this.#phase = "dead";
    const remoteEphemeral = this.#remoteEphemeral;
    if (!remoteEphemeral) throw new MuseProtocolError("缺少远端临时密钥");
    const local = keyPair(this.#fixedKeys?.static);
    const encryptedStatic = this.#encrypt(local.publicKey);
    this.#mixKey(dh(local.privateKey, remoteEphemeral));
    const message = Buffer.concat([encryptedStatic, this.#encrypt(EMPTY)]);
    const [send, receive] = hkdfPair(this.#ck, EMPTY);
    this.#ck = Buffer.alloc(32);
    this.#h = Buffer.alloc(32);
    this.#ephemeral = undefined;
    this.#remoteEphemeral = undefined;
    this.#phase = "done";
    return { message, send: new CipherState(send), receive: new CipherState(receive) };
  }
}
