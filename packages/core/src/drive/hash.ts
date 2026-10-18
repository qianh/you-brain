import { createHash } from "node:crypto";

export function md5Hex(bytes: Buffer): string {
  return createHash("md5").update(bytes).digest("hex");
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
