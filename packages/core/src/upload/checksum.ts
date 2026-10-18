import { YouBrainError } from "../domain/errors.js";
import { md5Hex } from "../drive/hash.js";

export class ChecksumMismatchError extends YouBrainError {
  constructor(
    readonly fileId: string,
    readonly expectedMd5: string,
    readonly actualMd5: string,
  ) {
    super(
      "UPLOAD_FAILED",
      `Drive md5Checksum ${actualMd5} does not match local md5 ${expectedMd5}`,
      true,
    );
    this.name = "ChecksumMismatchError";
  }
}

export function assertChecksum(
  file: { id: string; md5Checksum: string },
  bytes: Buffer,
): void {
  const expectedMd5 = md5Hex(bytes);
  if (file.md5Checksum !== expectedMd5) {
    throw new ChecksumMismatchError(file.id, expectedMd5, file.md5Checksum);
  }
}
