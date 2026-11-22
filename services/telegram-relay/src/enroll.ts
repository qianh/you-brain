import { createHash, createPublicKey, randomBytes } from "node:crypto";

import type { RelayAuditEntry } from "./audit.js";
import { PAIR_ALPHABET, type RelayStorage } from "./core.js";

/**
 * 设备凭据、一次性邀请码与入网/吊销管理（协议第 1 节）。
 *
 * 存储键：
 * - `enrolled`：`Record<string, EnrolledDevice>`
 * - `invites`：`InviteRecord[]`
 * - `inviteFailures`：累计错误兑换次数，达到 5 次作废当前全部邀请码
 */

export interface EnrolledDevice {
  name: string;
  tokenHash: string;
  publicKey: string;
  createdAt: number;
  revokedAt?: number;
}

export type EnrolledMap = Record<string, EnrolledDevice>;

export interface InviteRecord {
  code: string;
  expiresAt: number;
}

export interface EnrollPorts {
  storage: RelayStorage;
  now(): number;
  randomInt(max: number): number;
  audit(entry: RelayAuditEntry): Promise<void> | void;
}

export interface EnrollResult {
  status: number;
  body: Record<string, unknown>;
}

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const TOKEN_PREFIX = "ubd_";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const INVITE_LENGTH = 8;
const INVITE_TTL_MS = 10 * 60_000;
const INVITE_MAX_FAILURES = 5;

export function sameText(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
}

/** 校验 base64url 编码的 Ed25519 SPKI DER 公钥。 */
export function isValidEd25519PublicKey(publicKey: unknown): publicKey is string {
  if (typeof publicKey !== "string" || publicKey.length === 0 || !BASE64URL_RE.test(publicKey)) {
    return false;
  }
  try {
    const der = Buffer.from(publicKey, "base64url");
    if (der.length === 0 || der.toString("base64url") !== publicKey) return false;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export class EnrollStore {
  readonly #ports: EnrollPorts;

  constructor(ports: EnrollPorts) {
    this.#ports = ports;
  }

  async enrolled(): Promise<EnrolledMap> {
    return (await this.#ports.storage.get<EnrolledMap>("enrolled")) ?? {};
  }

  async getActive(deviceId: string): Promise<EnrolledDevice | undefined> {
    const map = await this.enrolled();
    const record = map[deviceId];
    if (!record || record.revokedAt !== undefined) return undefined;
    return record;
  }

  /** 按原始设备令牌查找未吊销设备（常量时间比对 sha256 hex）。 */
  async authenticateToken(token: string): Promise<{ deviceId: string; device: EnrolledDevice } | null> {
    if (!token.startsWith(TOKEN_PREFIX) || token.length <= TOKEN_PREFIX.length) return null;
    const hash = sha256Hex(token);
    const map = await this.enrolled();
    let matchedId: string | null = null;
    let matchedDevice: EnrolledDevice | null = null;
    for (const [deviceId, device] of Object.entries(map)) {
      if (sameText(device.tokenHash, hash)) {
        matchedId = deviceId;
        matchedDevice = device;
      }
    }
    if (matchedId === null || matchedDevice === null || matchedDevice.revokedAt !== undefined) return null;
    return { deviceId: matchedId, device: matchedDevice };
  }

  /** 生成 8 位一次性邀请码（10 分钟有效）。 */
  async createInvite(): Promise<{ code: string; expiresAt: string }> {
    const now = this.#ports.now();
    const existing = ((await this.#ports.storage.get<InviteRecord[]>("invites")) ?? []).filter(
      (item) => item.expiresAt > now,
    );
    let code = "";
    for (let index = 0; index < INVITE_LENGTH; index += 1) {
      code += PAIR_ALPHABET[this.#ports.randomInt(PAIR_ALPHABET.length)];
    }
    const expiresAt = now + INVITE_TTL_MS;
    existing.push({ code, expiresAt });
    await this.#ports.storage.put("invites", existing);
    await this.#ports.audit({ ts: now, from: "admin", to: null, kind: "invite", outcome: "ok" });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** 兑换邀请码入网；返回 HTTP 状态码和响应体。 */
  async redeem(input: {
    code?: unknown;
    deviceId?: unknown;
    name?: unknown;
    publicKey?: unknown;
  }): Promise<EnrollResult> {
    const now = this.#ports.now();
    const deviceId = cleanText(input.deviceId, 64);
    if (!DEVICE_ID_RE.test(deviceId)) {
      await this.#ports.audit({ ts: now, from: deviceId || null, to: null, kind: "enroll", outcome: "rejected:bad_device" });
      return { status: 400, body: { error: "设备 ID 不合法" } };
    }
    const name = cleanText(input.name, 40) || deviceId;
    if (!isValidEd25519PublicKey(input.publicKey)) {
      await this.#ports.audit({ ts: now, from: deviceId, to: null, kind: "enroll", outcome: "rejected:bad_public_key" });
      return { status: 400, body: { error: "公钥不合法" } };
    }
    const rawCode = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
    if (rawCode.length === 0) {
      await this.#ports.audit({ ts: now, from: deviceId, to: null, kind: "enroll", outcome: "rejected:invalid_invite" });
      return { status: 400, body: { error: "缺少邀请码" } };
    }

    const invites = (await this.#ports.storage.get<InviteRecord[]>("invites")) ?? [];
    let matchIndex = -1;
    for (let index = 0; index < invites.length; index += 1) {
      const item = invites[index]!;
      const same = sameText(item.code, rawCode);
      if (same && item.expiresAt > now && matchIndex === -1) {
        matchIndex = index;
      }
    }

    if (matchIndex === -1) {
      const failures = ((await this.#ports.storage.get<number>("inviteFailures")) ?? 0) + 1;
      if (failures >= INVITE_MAX_FAILURES) {
        await this.#ports.storage.put("invites", []);
        await this.#ports.storage.put("inviteFailures", 0);
      } else {
        await this.#ports.storage.put("inviteFailures", failures);
      }
      await this.#ports.audit({ ts: now, from: deviceId, to: null, kind: "enroll", outcome: "rejected:invalid_invite" });
      return { status: 401, body: { error: "邀请码无效或已过期" } };
    }

    const enrolled = await this.enrolled();
    const existing = enrolled[deviceId];
    if (existing && existing.revokedAt === undefined) {
      await this.#ports.audit({ ts: now, from: deviceId, to: null, kind: "enroll", outcome: "rejected:already_enrolled" });
      return { status: 409, body: { error: "设备已入网，请先吊销后再重新入网" } };
    }

    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const remaining = invites.filter((item, index) => index !== matchIndex && item.expiresAt > now);
    enrolled[deviceId] = {
      name,
      tokenHash: sha256Hex(token),
      publicKey: input.publicKey,
      createdAt: now,
    };
    await this.#ports.storage.put("enrolled", enrolled);
    await this.#ports.storage.put("invites", remaining);
    await this.#ports.storage.put("inviteFailures", 0);
    await this.#ports.audit({ ts: now, from: deviceId, to: null, kind: "enroll", outcome: "ok" });
    return { status: 200, body: { token } };
  }

  /** 吊销已入网设备；不删除历史记录，只写 `revokedAt`。 */
  async revoke(deviceId: string): Promise<{ ok: true; deviceId: string; revokedAt: number } | { ok: false; status: number; error: string }> {
    const now = this.#ports.now();
    const cleanId = cleanText(deviceId, 64);
    if (!DEVICE_ID_RE.test(cleanId)) {
      return { ok: false, status: 400, error: "设备 ID 不合法" };
    }
    const enrolled = await this.enrolled();
    const record = enrolled[cleanId];
    if (!record) {
      await this.#ports.audit({ ts: now, from: "admin", to: cleanId, kind: "revoke", outcome: "not_found" });
      return { ok: false, status: 404, error: "设备不存在" };
    }
    if (record.revokedAt === undefined) {
      record.revokedAt = now;
      await this.#ports.storage.put("enrolled", enrolled);
    }
    await this.#ports.audit({ ts: now, from: "admin", to: cleanId, kind: "revoke", outcome: "ok" });
    return { ok: true, deviceId: cleanId, revokedAt: record.revokedAt };
  }

  /** 列出全部已入网设备（不含 `tokenHash`）。 */
  async listDevices(onlineIds: ReadonlySet<string>): Promise<Array<{
    deviceId: string;
    name: string;
    publicKey: string;
    createdAt: number;
    revokedAt?: number;
    online: boolean;
  }>> {
    const enrolled = await this.enrolled();
    return Object.entries(enrolled)
      .sort((a, b) => b[1].createdAt - a[1].createdAt)
      .map(([deviceId, device]) => ({
        deviceId,
        name: device.name,
        publicKey: device.publicKey,
        createdAt: device.createdAt,
        ...(device.revokedAt !== undefined ? { revokedAt: device.revokedAt } : {}),
        online: onlineIds.has(deviceId),
      }));
  }
}
