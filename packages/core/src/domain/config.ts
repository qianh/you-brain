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

export const LocalConfigSchema = z.object({
  version: z.literal(1),
  deviceId: z.uuid(),
  displayName: z.string().min(1),
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
  driveRoot?: string;
}): LocalConfig {
  return LocalConfigSchema.parse({
    version: 1,
    deviceId: options.deviceId ?? randomUUID(),
    displayName: options.displayName ?? options.hostname,
    driveRoot: options.driveRoot ?? DEFAULT_DRIVE_ROOT,
    driveRootId: "",
    oauth: { mode: "official", clientId: "" },
    account: { email: "", displayName: "", permissionId: "" },
    dataDir: options.dataDir,
  });
}
