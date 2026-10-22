import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { linuxBundlePath } from "../native/layout.js";

export interface WebDirInput {
  env: NodeJS.ProcessEnv;
  execPath: string;
  moduleUrl: string;
  cwd: string;
}

/** Directory that exists. A set-but-missing env path falls through. */
async function directory(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? path : null;
  } catch {
    return null;
  }
}

async function sourceDist(start: string): Promise<string | null> {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const found = await directory(join(dir, "apps", "web", "dist"));
    if (found) return found;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Web UI directory, in order:
 * `YOU_BRAIN_WEB_DIR`, executable-sibling `web/`, macOS `../Resources/web`,
 * Linux `../lib/<productName>/web`, then `apps/web/dist` walked from the
 * source module and the working directory.
 */
export async function resolveWebDir(input: WebDirInput): Promise<string | null> {
  const fromEnv = input.env.YOU_BRAIN_WEB_DIR?.trim();
  if (fromEnv) {
    const resolved = await directory(resolve(fromEnv));
    if (resolved) return resolved;
  }
  const execDir = dirname(input.execPath);
  const sibling = await directory(join(execDir, "web"));
  if (sibling) return sibling;
  const resources = await directory(resolve(execDir, "..", "Resources", "web"));
  if (resources) return resources;
  const linux = await directory(linuxBundlePath(execDir, "web"));
  if (linux) return linux;
  let moduleDir = execDir;
  try {
    moduleDir = dirname(fileURLToPath(input.moduleUrl));
  } catch {
    moduleDir = execDir;
  }
  return (await sourceDist(moduleDir)) ?? (await sourceDist(input.cwd));
}
