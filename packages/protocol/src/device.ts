import { z } from "zod";

import { IsoTimestampSchema } from "./formats.js";
import { PROTOCOL_VERSION } from "./version.js";

export const DEVICE_KINDS = ["desktop", "server", "virtual"] as const;

export const DeviceKindSchema = z.enum(DEVICE_KINDS);

export type DeviceKind = z.infer<typeof DeviceKindSchema>;

export const DEVICE_PLATFORMS = ["darwin", "linux", "bot"] as const;

export const DevicePlatformSchema = z.enum(DEVICE_PLATFORMS);

export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DEVICE_CAPABILITIES = ["capture", "refine", "consolidate"] as const;

export const DeviceCapabilitySchema = z.enum(DEVICE_CAPABILITIES);

export type DeviceCapability = z.infer<typeof DeviceCapabilitySchema>;

export const DeviceRecordSchema = z.object({
  deviceId: z.uuid(),
  displayName: z.string().min(1),
  kind: DeviceKindSchema,
  platform: DevicePlatformSchema,
  appVersion: z.string().min(1),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  capabilities: z.array(DeviceCapabilitySchema),
  lastSeenAt: IsoTimestampSchema,
  lastActiveAt: IsoTimestampSchema,
});

export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export function parseDeviceRecord(input: unknown): DeviceRecord {
  return DeviceRecordSchema.parse(input);
}
