/**
 * 已入网设备在云盘里登记的派活身份。云盘账号是信任边界：同账号设备读这里的公钥验签，
 * 不信中转转来的公钥，中转被攻破也伪造不了指令。
 */
export interface RelayMemberFile {
  /** 中转里的设备 ID（派活用的那个，不是云盘设备记录的 ID）。 */
  deviceId: string;
  name: string;
  /** base64url 编码的 Ed25519 SPKI 公钥。 */
  publicKey: string;
  updatedAt: string;
}

export function parseRelayMember(input: unknown): RelayMemberFile | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.deviceId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/u.test(value.deviceId)) return null;
  if (typeof value.publicKey !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value.publicKey)) return null;
  const name = typeof value.name === "string" && value.name.trim() !== "" ? value.name.trim().slice(0, 40) : value.deviceId;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  return { deviceId: value.deviceId, name, publicKey: value.publicKey, updatedAt };
}
