import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** dsh 的 Node 下限（其 package.json engines / 开发文档：24.9）。 */
export const DSH_MIN_NODE = [24, 9, 0] as const;

export type NodeVersion = readonly [number, number, number];

export interface LocatedNode {
  path: string;
  version: NodeVersion;
}

export function parseNodeVersion(text: string): NodeVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareNodeVersion(a: NodeVersion, b: NodeVersion): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function nodeVersionSupported(version: NodeVersion): boolean {
  return compareNodeVersion(version, DSH_MIN_NODE) >= 0;
}

export interface LocateNodeOptions {
  /** 配置或环境变量强制指定的 node 路径；指定了就不再回退。 */
  override?: string;
  env?: NodeJS.ProcessEnv;
  homeDir: string;
  /** 测试注入：返回 `node --version` 的输出。 */
  probe?: (path: string) => Promise<string>;
  /** 测试注入：额外候选。 */
  extraCandidates?: readonly string[];
}

async function defaultProbe(path: string): Promise<string> {
  const { stdout } = await run(path, ["--version"], { timeout: 5_000 });
  return String(stdout);
}

function versionedDirs(root: string, bin: string): string[] {
  try {
    return readdirSync(root).map((name) => join(root, name, bin));
  } catch {
    return [];
  }
}

function candidatePaths(options: LocateNodeOptions): string[] {
  const { homeDir } = options;
  const env = options.env ?? process.env;
  const out: string[] = [];
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir !== "") out.push(join(dir, "node"));
  }
  out.push(
    ...versionedDirs(join(homeDir, ".local", "share", "fnm", "node-versions"), join("installation", "bin", "node")),
    ...versionedDirs(join(homeDir, ".fnm", "node-versions"), join("installation", "bin", "node")),
    ...versionedDirs(join(homeDir, ".nvm", "versions", "node"), join("bin", "node")),
    "/opt/homebrew/opt/node@24/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  );
  out.push(...(options.extraCandidates ?? []));
  return [...new Set(out)];
}

/**
 * 找一个满足 dsh 下限的 Node。指定了 override 就只认它；否则在 PATH 与常见
 * 版本管理器目录里挑版本最高且达标的。找不到返回 null，由调用方给出可读提示。
 */
export async function locateNode(options: LocateNodeOptions): Promise<LocatedNode | null> {
  const probe = options.probe ?? defaultProbe;
  const override = options.override?.trim() ?? "";
  const paths = override !== "" ? [override] : candidatePaths(options);
  let best: LocatedNode | null = null;
  for (const path of paths) {
    if (options.probe === undefined && !existsSync(path)) continue;
    let version: NodeVersion | null;
    try {
      version = parseNodeVersion(await probe(path));
    } catch {
      continue;
    }
    if (version === null || !nodeVersionSupported(version)) continue;
    if (best === null || compareNodeVersion(version, best.version) > 0) best = { path, version };
  }
  return best;
}
