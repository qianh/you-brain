import { randomUUID } from "node:crypto";

import { DEFAULT_DRIVE_ROOT } from "@you-brain/protocol";
import { z } from "zod";

export {
  platformPaths,
  portraitFile,
  type PlatformPathOptions,
  type YouBrainPaths,
} from "./paths.js";

export const OAUTH_MODES = ["official", "custom"] as const;

export const OauthModeSchema = z.enum(OAUTH_MODES);

export type OauthMode = z.infer<typeof OauthModeSchema>;

/**
 * 这台机器扮演的角色。只影响本机行为，不写进 Drive。
 * `desktop`：带界面的日常设备，采集本机 CLI 会话。
 * `server`：无界面常开主设备，不采集本机会话，负责沉淀与网页会话提炼。
 */
export const DEVICE_ROLES = ["desktop", "server"] as const;

export const DeviceRoleSchema = z.enum(DEVICE_ROLES);

export type DeviceRole = z.infer<typeof DeviceRoleSchema>;

export const LocalConfigSchema = z.object({
  version: z.literal(1),
  deviceId: z.uuid(),
  displayName: z.string().min(1),
  /** 旧配置文件没有这个字段，按桌面设备处理。 */
  role: DeviceRoleSchema.default("desktop"),
  driveRoot: z.string().min(1),
  driveRootId: z.string(),
  oauth: z.object({
    mode: OauthModeSchema,
    clientId: z.string(),
  }),
  account: z.object({
    email: z.string(),
    displayName: z.string(),
    permissionId: z.string(),
  }),
  dataDir: z.string().min(1),
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export function createDefaultLocalConfig(options: {
  hostname: string;
  dataDir: string;
  deviceId?: string;
  displayName?: string;
  role?: DeviceRole;
  driveRoot?: string;
}): LocalConfig {
  return LocalConfigSchema.parse({
    version: 1,
    deviceId: options.deviceId ?? randomUUID(),
    displayName: options.displayName ?? options.hostname,
    role: options.role ?? "desktop",
    driveRoot: options.driveRoot ?? DEFAULT_DRIVE_ROOT,
    driveRootId: "",
    oauth: { mode: "official", clientId: "" },
    account: { email: "", displayName: "", permissionId: "" },
    dataDir: options.dataDir,
  });
}
