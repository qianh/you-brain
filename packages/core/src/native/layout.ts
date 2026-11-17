import { resolve } from "node:path";

/**
 * `productName` in `apps/desktop/src-tauri/tauri.conf.json`.
 * Tauri names the Linux resource directory with this string:
 * deb and AppImage both use `usr/lib/<productName>/`.
 */
export const DESKTOP_PRODUCT_NAME = "U-Brain";

/** 服务器包（scripts/build-server.ts）沿用改名前的 `lib/you-brain/`，已部署的服务器升级时目录不变。 */
export const SERVER_LIB_NAME = "you-brain";

/**
 * Sidecar lives in `usr/bin`. Resources live in `usr/lib/<name>/`.
 * From the sidecar directory that is `../lib/<name>/<child...>`：先找桌面包，再找服务器包。
 */
export function linuxBundlePaths(execDir: string, ...child: string[]): string[] {
  return [DESKTOP_PRODUCT_NAME, SERVER_LIB_NAME].map((name) => resolve(execDir, "..", "lib", name, ...child));
}
