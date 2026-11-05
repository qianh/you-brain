/**
 * 打包时复用没有变化的依赖目录。
 *
 * vendor 和 dsh 的 node_modules 占了打包的大部分时间，而且都要联网：依赖没变也重装一遍，
 * 网络一抖就会停在 `Resolving dependencies` 上，几分钟没有任何输出。这里按输入内容算出 key，
 * key 没变就直接取上次的结果；版本、锁文件或裁剪规则一变，key 随之变化，不会用到旧依赖。
 *
 * 设置 YOU_BRAIN_NO_BUILD_CACHE=1 可强制重装。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, readlink, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const REGISTRY = "https://registry.npmmirror.com";
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const INSTALL_ATTEMPTS = 2;

export function hashInputs(parts: ReadonlyArray<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part) : part;
    // 带上长度，避免 ["ab", "c"] 和 ["a", "bc"] 得到同一个 key。
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** 目录的内容摘要：包含相对路径、文件内容和符号链接指向。 */
export async function hashDir(path: string): Promise<string> {
  const parts: Array<string | Uint8Array> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, `${relative}/`);
      } else if (entry.isSymbolicLink()) {
        parts.push(relative, await readlink(full));
      } else if (entry.isFile()) {
        parts.push(relative, await readFile(full));
      }
    }
  };
  await walk(path, "");
  return hashInputs(parts);
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** macOS 上用 APFS clonefile，几乎不占时间和额外磁盘；符号链接原样保留。 */
async function cloneTree(from: string, to: string): Promise<void> {
  const args = process.platform === "darwin" ? ["cp", "-cR", from, to] : ["cp", "-a", from, to];
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`复制 ${from} 失败，退出 ${code}`);
}

export interface CachedTreeOptions {
  cacheRoot: string;
  /** 同名条目只保留最新的一份，避免旧依赖不断占用磁盘。 */
  name: string;
  key: string;
  dest: string;
  /** 把结果写到 `out`。中途失败不会留下可被复用的条目。 */
  build: (out: string) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export async function cachedTree(options: CachedTreeOptions): Promise<"hit" | "miss"> {
  const { cacheRoot, name, key, dest, build, env = process.env } = options;
  const entry = join(cacheRoot, `${name}-${key.slice(0, 16)}`);
  const reuse = env.YOU_BRAIN_NO_BUILD_CACHE !== "1" && (await isDir(entry));
  if (!reuse) {
    await mkdir(cacheRoot, { recursive: true });
    const staging = `${entry}.tmp-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    try {
      await build(staging);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    for (const existing of await readdir(cacheRoot)) {
      const path = join(cacheRoot, existing);
      if (existing.startsWith(`${name}-`) && path !== staging) {
        await rm(path, { recursive: true, force: true });
      }
    }
    await rename(staging, entry);
  }
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });
  await cloneTree(entry, dest);
  console.log(`${name}: ${reuse ? "依赖没变，复用上次结果" : "已重新安装"}`);
  return reuse ? "hit" : "miss";
}

export interface RunInstallOptions {
  env?: Record<string, string>;
  timeoutMs?: number;
  attempts?: number;
  /** 第一次不走代理，之后的重试才用环境里的代理。 */
  directFirst?: boolean;
}

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

/**
 * 跑一次依赖安装：默认走 npmmirror，卡住时到点结束并重试，不再无声地一直等。
 * 已经设置的 registry 变量优先。
 */
export async function runInstall(
  args: string[],
  cwd: string,
  options: RunInstallOptions = {},
): Promise<void> {
  const {
    env = {},
    timeoutMs = INSTALL_TIMEOUT_MS,
    attempts = INSTALL_ATTEMPTS,
    directFirst = false,
  } = options;
  let reason = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    console.log(`$ ${args.join(" ")}${attempt > 1 ? `（第 ${attempt} 次）` : ""}`);
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      BUN_CONFIG_REGISTRY: process.env.BUN_CONFIG_REGISTRY || REGISTRY,
      npm_config_registry: process.env.npm_config_registry || REGISTRY,
      ...env,
    };
    if (directFirst && attempt === 1) {
      for (const name of PROXY_VARS) delete childEnv[name];
    }
    const child = Bun.spawn(args, {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env: childEnv,
    });
    const code = await child.exited;
    if (code === 0) return;
    reason =
      child.signalCode === "SIGKILL"
        ? `${Math.round(timeoutMs / 1000)} 秒内没有完成`
        : `退出 ${code}`;
    console.error(`${args[0] ?? "command"} ${reason}`);
  }
  throw new Error(`${args[0] ?? "command"} ${reason}，已重试 ${attempts} 次`);
}
