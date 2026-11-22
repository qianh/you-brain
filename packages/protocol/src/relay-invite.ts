/**
 * 同一个云盘账号下的设备自动入网：已入网的设备把中转地址和一个短期邀请码写进云盘，
 * 新设备读到后自动兑换。云盘账号就是信任边界，所以邀请码只活 10 分钟、只能用一次。
 */
export interface RelayInviteFile {
  /** 中转地址（不含末尾斜杠）。 */
  url: string;
  /** 一次性邀请码。 */
  code: string;
  /** 邀请码过期时间（ISO）。 */
  expiresAt: string;
  /** 写入这份文件的设备 ID，便于排查。 */
  issuedBy: string;
}

export function parseRelayInvite(input: unknown): RelayInviteFile | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.url !== "string" || !/^https?:\/\//u.test(value.url)) return null;
  if (typeof value.code !== "string" || !/^[A-Za-z0-9]{6,16}$/u.test(value.code)) return null;
  if (typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt))) return null;
  if (typeof value.issuedBy !== "string" || value.issuedBy === "") return null;
  return { url: value.url, code: value.code, expiresAt: value.expiresAt, issuedBy: value.issuedBy };
}
