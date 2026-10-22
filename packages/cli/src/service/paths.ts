import { join } from "node:path";

export const SERVICE_LABEL = "com.you-brain.daemon";
export const SYSTEMD_UNIT = "you-brain.service";

export type ServicePlatform = "darwin" | "linux";

/** launchd 标签与 systemd 单元名，和 uninstall 清理的路径一致。 */
export function serviceUnitPath(platform: ServicePlatform, homeDir: string): string {
  if (platform === "darwin") {
    return join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  }
  return join(homeDir, ".config", "systemd", "user", SYSTEMD_UNIT);
}

export function daemonLogPath(dataDir: string): string {
  return join(dataDir, "logs", "daemon.log");
}

export function serviceLogHint(platform: ServicePlatform, dataDir: string): string {
  if (platform === "linux") return `journalctl --user -u ${SYSTEMD_UNIT} -f`;
  return daemonLogPath(dataDir);
}
