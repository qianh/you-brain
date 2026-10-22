import type { DeviceCapability, DeviceRecord } from "./device.js";
import { parseDeviceRecord } from "./device.js";
import { PROTOCOL_VERSION } from "./version.js";

const DEFAULT_CAPABILITIES: DeviceCapability[] = ["refine", "consolidate"];

/** A bot record. `deviceId` defaults to `crypto.randomUUID()`. */
export function createVirtualDeviceRecord(input: {
  deviceId?: string;
  displayName: string;
  capabilities?: DeviceCapability[];
  appVersion?: string;
  now?: Date;
}): DeviceRecord {
  const now = (input.now ?? new Date()).toISOString();
  return parseDeviceRecord({
    deviceId: input.deviceId ?? crypto.randomUUID(),
    displayName: input.displayName,
    kind: "virtual",
    platform: "bot",
    appVersion: input.appVersion ?? "virtual",
    protocolVersion: PROTOCOL_VERSION,
    capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
    lastSeenAt: now,
    lastActiveAt: now,
  });
}
