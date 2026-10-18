/** Paths relative to the Drive root (default name: brain-hub). */
export const DRIVE_PATHS = {
  inbox: "inbox",
  inboxAssets: "inbox/_assets/sha256",
  digitalTwin: "digital-twin",
  topics: "topics",
  topicsLatest: "topics/TOPICS-latest.md",
  topicsHistory: "topics/history",
  youBrain: "you-brain",
  protocolFile: "you-brain/protocol.json",
  sharedConfig: "you-brain/config/shared.json",
  roles: "you-brain/config/roles.json",
  devicesDir: "you-brain/devices",
  eventsDir: "you-brain/events",
  consolidateLease: "you-brain/leases/consolidate.json",
} as const;

function assertSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertDay(day: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) throw new Error(`Invalid event day: ${day}`);
  const yearText = match[1];
  const monthText = match[2];
  const dateText = match[3];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dateText === undefined
  ) {
    throw new Error(`Invalid event day: ${day}`);
  }
  const year = Number(yearText);
  const month = Number(monthText);
  const date = Number(dateText);
  const utc = new Date(Date.UTC(year, month - 1, date));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== date
  ) {
    throw new Error(`Invalid event day: ${day}`);
  }
}

export function deviceRecordPath(deviceId: string): string {
  return `${DRIVE_PATHS.devicesDir}/${assertSegment(deviceId, "deviceId")}.json`;
}

export function eventLogPath(deviceId: string, day: string): string {
  assertDay(day);
  return `${DRIVE_PATHS.eventsDir}/${assertSegment(deviceId, "deviceId")}/${day}.jsonl`;
}

export function inboxDeviceDir(device: string): string {
  return `${DRIVE_PATHS.inbox}/${assertSegment(device, "device")}`;
}

export function inboxWebDir(profile: string): string {
  return `${DRIVE_PATHS.inbox}/web-${assertSegment(profile, "profile")}`;
}

export function inboxSessionPath(device: string, filename: string): string {
  return `${inboxDeviceDir(device)}/${assertSegment(filename, "filename")}`;
}

export function inboxAssetPath(sha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Invalid sha256");
  return `${DRIVE_PATHS.inboxAssets}/${sha256.slice(0, 2)}/${sha256}.webp`;
}

export function topicDetailPath(slug: string): string {
  return `${DRIVE_PATHS.topics}/${assertSegment(slug, "topic slug")}.md`;
}

export function topicHistoryPath(slug: string): string {
  return `${DRIVE_PATHS.topicsHistory}/${assertSegment(slug, "topic slug")}.md`;
}
