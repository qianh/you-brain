/** `portrait.version` keeps etag, md5, and the Drive path. The table has no md5 column. */
export interface PortraitMeta {
  etag: string;
  md5: string;
  drivePath: string;
}

export function encodePortraitMeta(meta: PortraitMeta): string {
  return JSON.stringify({
    v: 1,
    etag: meta.etag,
    md5: meta.md5,
    drivePath: meta.drivePath,
  });
}

export function decodePortraitMeta(version: string): PortraitMeta | null {
  try {
    const parsed = JSON.parse(version) as Partial<PortraitMeta> & { v?: unknown };
    if (parsed.v !== 1) return null;
    if (
      typeof parsed.etag !== "string" ||
      typeof parsed.md5 !== "string" ||
      typeof parsed.drivePath !== "string"
    ) {
      return null;
    }
    return { etag: parsed.etag, md5: parsed.md5, drivePath: parsed.drivePath };
  } catch {
    return null;
  }
}
