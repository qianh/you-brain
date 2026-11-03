import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { linuxBundlePath } from "../../native/layout.js";

export interface BundledDsh {
  /** 随 App 打包的 Node（≥ 24.9）。 */
  node: string;
  /** 裁剪后的 sidecar 目录（login-oauth.mjs、node_modules）。 */
  sidecarDir: string;
}

/**
 * 随 App 打包的 DSH 运行时，按顺序找：`YOU_BRAIN_DSH_DIR`、可执行文件旁的 `dsh/`、
 * macOS 的 `../Resources/dsh`、Linux 的安装目录。开发环境（可执行文件是 bun）里没有这些，返回 null。
 */
export function bundledDsh(execPath: string, env: NodeJS.ProcessEnv = process.env): BundledDsh | null {
  const execDir = dirname(execPath);
  const candidates = [
    env.YOU_BRAIN_DSH_DIR?.trim() ?? "",
    join(execDir, "dsh"),
    resolve(execDir, "..", "Resources", "dsh"),
    linuxBundlePath(execDir, "dsh"),
  ].filter((path) => path !== "");
  for (const dir of candidates) {
    const node = join(dir, "node");
    const sidecarDir = join(dir, "sidecar");
    if (existsSync(node) && existsSync(join(sidecarDir, "login-oauth.mjs"))) return { node, sidecarDir };
  }
  return null;
}
