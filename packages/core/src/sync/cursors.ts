export const SYNC_DRIVE_CURSOR = "sync.drive";

export function seqCursorKey(deviceId: string): string {
  return `sync.seq.${deviceId}`;
}

export function outboxCursorKey(deviceId: string): string {
  return `sync.outbox.${deviceId}`;
}

export function lineCursorKey(fileId: string): string {
  return `sync.lines.${fileId}`;
}

/** What this device last uploaded for an event file, so a pull can skip re-reading it. */
export function selfUploadKey(fileId: string): string {
  return `sync.self.${fileId}`;
}
