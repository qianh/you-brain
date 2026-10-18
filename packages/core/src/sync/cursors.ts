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
