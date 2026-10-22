/** A device counts as online while its last heartbeat is under 10 minutes old. */
export const ONLINE_MS = 10 * 60 * 1000;

export const ROLE_CAPABILITY = {
  main: "consolidate",
  web: "refine",
} as const;

export type DeviceRole = keyof typeof ROLE_CAPABILITY;

export interface RoleDevice {
  deviceId: string;
  capabilities: readonly string[];
}

export function isDeviceOnline(lastSeenAt: string, now = Date.now()): boolean {
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return false;
  const age = now - seen;
  if (age < 0) return true;
  return age < ONLINE_MS;
}

/** This machine stays first. Everything else keeps the order the daemon sent. */
export function orderDevices<T extends { deviceId: string }>(
  devices: readonly T[],
  localId: string | null,
): T[] {
  if (localId === null || localId === "") return [...devices];
  const local: T[] = [];
  const rest: T[] = [];
  for (const device of devices) {
    if (device.deviceId === localId) local.push(device);
    else rest.push(device);
  }
  return [...local, ...rest];
}

/**
 * Candidates are devices that declare the role's capability.
 * The current assignee stays in the list so a saved role does not disappear.
 * When nobody declares the capability, every device remains selectable:
 * a fresh install often reports capture only, and the role can still be set.
 */
export function roleCandidates<T extends RoleDevice>(
  devices: readonly T[],
  role: DeviceRole,
  currentId: string | null,
): T[] {
  const capability = ROLE_CAPABILITY[role];
  const capable = devices.filter((device) => device.capabilities.includes(capability));
  const base = capable.length > 0 ? capable : [...devices];
  if (currentId === null || currentId === "" || base.some((device) => device.deviceId === currentId)) {
    return base;
  }
  const current = devices.find((device) => device.deviceId === currentId);
  return current ? [current, ...base] : base;
}

/** `null` web processor means “follow the main device”. */
export function resolvedWebDevice(mainId: string | null, webId: string | null): string | null {
  return webId ?? mainId;
}

export function showAddDeviceHint(count: number): boolean {
  return count === 1;
}
