// Adapted from Meta's muse-gadget-sdk pairing v5 (Apache-2.0).
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import { object, requiredString } from "./api.js";
import { MuseProtocolError } from "./errors.js";

const LABEL = "hatch-link ble setup v1";
const sha256 = (...data: Uint8Array[]): Buffer => createHash("sha256").update(Buffer.concat(data)).digest();
const expand = (key: Uint8Array, info: string): Buffer =>
  createHmac("sha256", key).update(info).update(Buffer.from([1])).digest();
const encode = (value: Uint8Array): string => Buffer.from(value).toString("base64url");

function decode(value: unknown, max = 4096): Buffer {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.length % 4 === 1 ||
    !/^[\w-]+$/.test(value)
  ) {
    throw new MuseProtocolError("无效的配对消息编码");
  }
  return Buffer.from(value, "base64url");
}

function iv(direction: number, counter: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce[0] = direction;
  nonce.writeBigUInt64BE(counter, 4);
  return nonce;
}

export interface PairingIdentity {
  mac: string;
  nodeId: string;
  deviceId: string;
  name: string;
}

export function identityFromMac(mac: string): PairingIdentity {
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) {
    throw new MuseProtocolError("无效的设备身份格式");
  }
  const suffix = mac.replaceAll(":", "").slice(-6);
  return {
    mac,
    nodeId: `homelink-${suffix}`,
    deviceId: `hatch-link:${mac}`,
    name: `MuseGadget${suffix.toUpperCase()}`,
  };
}

export function newIdentity(): PairingIdentity {
  const raw = randomBytes(6);
  raw[0] = (raw[0]! & 0xfc) | 2;
  return identityFromMac([...raw].map((n) => n.toString(16).padStart(2, "0")).join(":"));
}

export class PairingSession {
  #rx: Buffer | undefined;
  #tx: Buffer | undefined;
  #sessionId = "";
  #received = 0n;
  #sent = 0n;
  #deadline = 0;
  #phase: "idle" | "waiting" | "ready" | "provisioning" = "idle";

  constructor(
    readonly identity: PairingIdentity,
    readonly version = "0.1.0",
    private readonly testOptions: { privateKey?: Buffer; nonce?: Buffer; now?: () => number } = {},
  ) {}

  #now(): number {
    return this.testOptions.now?.() ?? performance.now();
  }

  reset(): void {
    this.#rx?.fill(0);
    this.#tx?.fill(0);
    this.#rx = undefined;
    this.#tx = undefined;
    this.#phase = "idle";
    this.#deadline = 0;
    this.#sessionId = "";
  }

  #assertLive(): void {
    if (this.#phase === "idle" || this.#now() > this.#deadline) {
      this.reset();
      throw new MuseProtocolError("配对会话已过期，请重试");
    }
  }

  info(): Record<string, unknown> {
    return {
      device_id: this.identity.deviceId,
      mac: this.identity.mac,
      model: "hatch_link",
      pairing_protocol: 5,
      pairing_auth: "none",
      pairing_auth_epoch: 0,
      pairing_policy: "confirm_app",
    };
  }

  hello(command: Record<string, unknown>): Record<string, unknown> {
    this.reset();
    if (command.version !== 5 || command.pairing_auth !== "none" || command.pairing_policy !== "confirm_app") {
      throw new MuseProtocolError("不支持的配对协议版本");
    }
    const mobilePub = decode(command.mobile_pub);
    const mobileNonce = decode(command.mobile_nonce);
    if (mobilePub.length !== 65 || mobilePub[0] !== 4 || mobileNonce.length !== 16) {
      throw new MuseProtocolError("无效的手机端配对公钥");
    }
    const ecdh = createECDH("prime256v1");
    if (this.testOptions.privateKey) ecdh.setPrivateKey(this.testOptions.privateKey);
    else ecdh.generateKeys();
    const devicePub = ecdh.getPublicKey();
    const deviceNonce = this.testOptions.nonce ?? randomBytes(16);
    const transcript = [
      "hatch-link-pairing-v5",
      "version=5",
      "initiator_role=mobile",
      "responder_role=link",
      `device_id=${this.identity.deviceId}`,
      `node_id=${this.identity.nodeId}`,
      `mac=${this.identity.mac}`,
      "model=hatch_link",
      `firmware_version=${this.version}`,
      "selected_cipher_suite=p256-hkdf-sha256-aes-gcm-v1",
      "pairing_auth=none",
      "pairing_auth_epoch=0",
      "pairing_policy=confirm_app",
      "confirm_timeout_seconds=0",
      `mobile_pub=${encode(mobilePub)}`,
      `device_pub=${encode(devicePub)}`,
      `mobile_nonce=${encode(mobileNonce)}`,
      `device_nonce=${encode(deviceNonce)}`,
    ].join("\n");
    const transcriptHash = sha256(Buffer.from(transcript));
    const shared = ecdh.computeSecret(mobilePub);
    const secret = Buffer.from(
      hkdfSync("sha256", shared, sha256(mobileNonce, deviceNonce, transcriptHash), LABEL, 32),
    );
    this.#rx = expand(secret, "mobile->device");
    this.#tx = expand(secret, "device->mobile");
    this.#sessionId = encode(sha256(Buffer.from("hatch-link session id v1"), transcriptHash, shared).subarray(0, 16));
    secret.fill(0);
    shared.fill(0);
    this.#received = 0n;
    this.#sent = 0n;
    this.#phase = "waiting";
    this.#deadline = this.#now() + 60_000;
    return {
      type: "pairing_ready",
      version: 5,
      ...this.info(),
      node_id: this.identity.nodeId,
      firmware_version: this.version,
      device_pub: encode(devicePub),
      device_nonce: encode(deviceNonce),
      transcript_hash: encode(transcriptHash),
      session_id: this.#sessionId,
    };
  }

  decrypt(envelope: Record<string, unknown>): Record<string, unknown> {
    try {
      this.#assertLive();
      const counter = requiredString(envelope.counter, "pairing counter");
      if (
        !/^\d+$/.test(counter) ||
        counter.length > 20 ||
        BigInt(counter) !== this.#received ||
        this.#received >= 1n << 64n ||
        envelope.session_id !== this.#sessionId
      ) {
        throw new MuseProtocolError("配对消息序号或会话不匹配");
      }
      const ciphertext = decode(envelope.ciphertext, 16_384);
      const tag = decode(envelope.tag);
      if (tag.length !== 16 || !this.#rx) throw new MuseProtocolError("无效的认证标签");
      const cipher = createDecipheriv("aes-256-gcm", this.#rx, iv(0, this.#received));
      cipher.setAAD(Buffer.from(`${LABEL}|${this.#sessionId}|m2d|${this.#received}`));
      cipher.setAuthTag(tag);
      const plaintext = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
      this.#received++;
      return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)));
    } catch {
      this.reset();
      throw new MuseProtocolError("配对消息解密失败");
    }
  }

  confirm(command: Record<string, unknown>): void {
    this.#assertLive();
    if (
      this.#phase !== "waiting" ||
      this.#received !== 1n ||
      command.action !== "pairing_client_finished" ||
      Object.keys(command).length !== 1
    ) {
      this.reset();
      throw new MuseProtocolError("无效的配对确认消息");
    }
    this.#phase = "ready";
    this.#deadline = this.#now() + 120_000;
  }

  assertConfirmed(): void {
    this.#assertLive();
    if (this.#phase !== "ready" && this.#phase !== "provisioning") {
      throw new MuseProtocolError("尚未完成手机端授权确认");
    }
  }

  provision(): void {
    this.assertConfirmed();
    this.#phase = "provisioning";
    this.#deadline = this.#now() + 120_000;
  }

  encrypt(value: unknown): Record<string, unknown> {
    this.#assertLive();
    if (this.#sent >= 1n << 64n || !this.#tx) {
      this.reset();
      throw new MuseProtocolError("配对发送密钥不可用");
    }
    const counter = this.#sent++;
    const cipher = createCipheriv("aes-256-gcm", this.#tx, iv(1, counter));
    cipher.setAAD(Buffer.from(`${LABEL}|${this.#sessionId}|d2m|${counter}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return {
      type: "pairing_encrypted",
      session_id: this.#sessionId,
      counter: String(counter),
      ciphertext: encode(ciphertext),
      tag: encode(cipher.getAuthTag()),
    };
  }
}

export function encodePackets(data: Buffer): Buffer[] {
  const total = Math.max(1, Math.ceil(data.length / 17));
  if (total > 255) throw new MuseProtocolError("配对通知数据过大");
  return Array.from({ length: total }, (_, i) =>
    Buffer.concat([Buffer.from([0xfe, i, total]), data.subarray(i * 17, (i + 1) * 17)]),
  );
}

export class PacketAssembler {
  #parts: Buffer[] = [];
  #total = 0;
  #size = 0;

  reset(): void {
    this.#parts = [];
    this.#total = 0;
    this.#size = 0;
  }

  feed(packet: Buffer): Buffer | undefined {
    if (packet.length > 8192) {
      this.reset();
      throw new MuseProtocolError("BLE 分片过大");
    }
    if (packet.length < 3 || packet[0] !== 0xfe) return packet;
    const index = packet[1]!;
    const total = packet[2]!;
    if (!total) {
      this.reset();
      return undefined;
    }
    if (index === 0 || total !== this.#total) {
      this.reset();
      this.#total = total;
    }
    if (index !== this.#parts.length || index >= total) {
      this.reset();
      return undefined;
    }
    this.#size += packet.length - 3;
    if (this.#size > 8192) {
      this.reset();
      throw new MuseProtocolError("BLE 消息过大");
    }
    this.#parts.push(packet.subarray(3));
    if (this.#parts.length !== total) return undefined;
    const result = Buffer.concat(this.#parts);
    this.reset();
    return result;
  }
}
