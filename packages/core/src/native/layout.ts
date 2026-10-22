import { resolve } from "node:path";

/**
 * `productName` in `apps/desktop/src-tauri/tauri.conf.json`.
 * Tauri names the Linux resource directory with this string:
 * deb and AppImage both use `usr/lib/<productName>/`.
 */
export const DESKTOP_PRODUCT_NAME = "you-brain";

/**
 * Sidecar lives in `usr/bin`. Resources live in `usr/lib/<productName>/`.
 * From the sidecar directory that is `../lib/<productName>/<child...>`.
 */
export function linuxBundlePath(execDir: string, ...child: string[]): string {
  return resolve(execDir, "..", "lib", DESKTOP_PRODUCT_NAME, ...child);
}
