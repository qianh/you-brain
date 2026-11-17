/**
 * 打包指挥台的 DeepSeek Harness 运行时：Node 24 + 裁剪后的 sidecar。
 * 产物 `dist/daemon/<triple>/dsh/`：
 *   node                可执行的 Node（≥ 24.9，DSH 的要求；用户机器上不会有）
 *   sidecar/            login-oauth.mjs、plugins/（桥接与订阅登录插件）和裁剪后的 node_modules
 *
 * 裁掉的是可选的大块原生载荷（codex / claude-agent-sdk 的原生二进制、LibreOffice、语音、
 * 浏览器调试器）和类型声明/map/文档。裁掉 claude-code / codex 原生载荷后，对应的 DSH 子代理不会
 * 被挂载（见 deck/dsh/patch.ts 的载荷检查），本机 gemini / opencode 经 ACP 的接入不受影响。
 *
 * Usage: bun scripts/build-dsh.ts   （NODE24=/path/to/node 可指定构建用的 Node）
 */
import { chmod, copyFile, cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { locateNode } from "../packages/core/src/deck/dsh/node.ts";
import { cachedTree, hashDir, hashInputs, runInstall } from "./build-cache.ts";

const root = resolve(import.meta.dirname, "..");
const triple =
  process.platform === "darwin"
    ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
    : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
const source = join(root, "sidecars", "dsh-host");
const outDir = join(root, "dist", "daemon", triple, "dsh");
const sidecar = join(outDir, "sidecar");

/** 整目录删除：包名（含 scope）前缀匹配。 */
const DROP_PACKAGES: RegExp[] = [
  /^@openai\/codex-/u,
  /^@anthropic-ai\/claude-agent-sdk-/u,
  /^@deepseek-ai\/libreoffice-kit-/u,
  /^sherpa-onnx/u,
  /^@deepseek-ai\/dsh-experimental-inspector$/u,
  // sharp 的 wasm 兜底；macOS / Linux 都带原生 sharp，用不到。
  /^@img\/sharp-wasm32$/u,
];
const DROP_FILE = /(?:\.d\.(?:ts|mts|cts)|\.map|\.md|\.markdown)$/iu;
const KEEP_FILE = /^(?:license|licence|notice)/iu;

async function dirBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await dirBytes(full);
    else total += (await stat(full)).size;
  }
  return total;
}

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(0)} MB`;

async function prune(modules: string): Promise<void> {
  // 先按包名整包删（含各包自己嵌套的 node_modules）。
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        await walk(full, `${entry.name}/`);
        continue;
      }
      const name = `${prefix}${entry.name}`;
      if (DROP_PACKAGES.some((pattern) => pattern.test(name))) {
        await rm(full, { recursive: true, force: true });
        continue;
      }
      await walk(join(full, "node_modules"), "");
    }
  };
  await walk(modules, "");
  // 再删文件级的垃圾：类型声明、map、文档。
  const sweep = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await sweep(full);
      else if (DROP_FILE.test(entry.name) && !KEEP_FILE.test(entry.name)) await rm(full, { force: true });
    }
  };
  await sweep(modules);
  await hoistScopedDuplicates(modules);
}

type Manifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

async function listPackages(modules: string): Promise<string[]> {
  const names: string[] = [];
  let entries;
  try {
    entries = await readdir(modules, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!entry.name.startsWith("@")) {
      names.push(entry.name);
      continue;
    }
    for (const inner of await readdir(join(modules, entry.name), { withFileTypes: true })) {
      if (inner.isDirectory() && inner.name !== "node_modules") names.push(`${entry.name}/${inner.name}`);
    }
  }
  return names;
}

/**
 * 同一 scope 下多个包各自嵌套了同一版本的依赖时（DSH 的 51 个 @deepseek-ai 包各带一份 zod 4.4.3，
 * 共 250 MB），只留一份放到 `<scope>/node_modules/<dep>`，删掉其余副本。Node 的 CJS 和 ESM 解析
 * 都会先查 `@scope/node_modules` 再查顶层，所以这些包仍解析到同一版本。
 *
 * 不用符号链接：Tauri 打包资源时会把链接展开成实体文件，省不下体积。
 *
 * 提升后，同 scope 里原本解析到顶层的包也会改用这份。只有它们声明的版本范围都接受这个版本、
 * 且被提升的包没有自己的依赖（换了位置后解析不到）时才提升，否则保留原样。
 */
async function hoistScopedDuplicates(modules: string): Promise<void> {
  for (const scope of (await readdir(modules)).filter((name) => name.startsWith("@"))) {
    const scopeDir = join(modules, scope);
    const owners = (await readdir(scopeDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name);
    // 依赖名 → 版本 → 嵌套副本所在目录
    const copies = new Map<string, Map<string, string[]>>();
    for (const owner of owners) {
      const nested = join(scopeDir, owner, "node_modules");
      for (const dep of await listPackages(nested)) {
        const manifest = await readManifest(join(nested, dep));
        if (manifest?.version === undefined) continue;
        const byVersion = copies.get(dep) ?? new Map<string, string[]>();
        byVersion.set(manifest.version, [...(byVersion.get(manifest.version) ?? []), join(nested, dep)]);
        copies.set(dep, byVersion);
      }
    }
    for (const [dep, byVersion] of copies) {
      const [version, dirs] = [...byVersion].sort((a, b) => b[1].length - a[1].length)[0]!;
      if (dirs.length < 2) continue;
      const label = `${scope}/*/node_modules/${dep}@${version}`;
      const target = join(scopeDir, "node_modules", dep);
      if (await exists(target)) {
        console.log(`跳过提升 ${label}：${target} 已存在`);
        continue;
      }
      const hoisted = await readManifest(dirs[0]!);
      if (Object.keys({ ...hoisted?.dependencies, ...hoisted?.peerDependencies }).length > 0) {
        console.log(`跳过提升 ${label}：它自己有依赖，换位置后可能解析不到`);
        continue;
      }
      const conflicts: string[] = [];
      for (const owner of owners) {
        if (await exists(join(scopeDir, owner, "node_modules", dep))) continue;
        const manifest = await readManifest(join(scopeDir, owner));
        const range =
          manifest?.dependencies?.[dep] ?? manifest?.peerDependencies?.[dep] ?? manifest?.optionalDependencies?.[dep];
        if (range !== undefined && !Bun.semver.satisfies(version, range)) conflicts.push(`${scope}/${owner}（${range}）`);
      }
      if (conflicts.length > 0) {
        console.log(`跳过提升 ${label}：${conflicts.join("、")} 不接受 ${version}`);
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await rename(dirs[0]!, target);
      for (const dir of dirs.slice(1)) await rm(dir, { recursive: true, force: true });
      console.log(`已提升 ${label}：${dirs.length} 份合并为 1 份`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const node = await locateNode({
  homeDir: homedir(),
  ...(process.env.NODE24 !== undefined && process.env.NODE24 !== "" ? { override: process.env.NODE24 } : {}),
});
if (node === null) {
  console.error("找不到 Node ≥ 24.9，无法打包 DSH 运行时（可用 NODE24=/path/to/node 指定）");
  process.exit(2);
}
console.log(`使用 Node ${node.version.join(".")}：${node.path}`);

await rm(outDir, { recursive: true, force: true });
await mkdir(sidecar, { recursive: true });
for (const file of ["package.json", "package-lock.json", "login-oauth.mjs"]) {
  await copyFile(join(source, file), join(sidecar, file));
}
// 随 App 带的 dsh 插件（GUI App 桥等）。
await cp(join(source, "plugins"), join(sidecar, "plugins"), { recursive: true });

const modules = join(sidecar, "node_modules");
await cachedTree({
  cacheRoot: join(root, "dist", ".build-cache"),
  name: "dsh-modules",
  // 插件会被复制进 node_modules，所以也算输入；带上本脚本是因为裁剪规则写在这里。
  key: hashInputs([
    triple,
    node.version.join("."),
    await readFile(join(source, "package.json")),
    await readFile(join(source, "package-lock.json")),
    await hashDir(join(source, "plugins")),
    await readFile(import.meta.filename),
  ]),
  dest: modules,
  build: async (out) => {
    // 用打包所用的 Node 自带的 npm 做锁定版本的干净安装。
    const nodeBin = dirname(node.path);
    await runInstall([join(nodeBin, "npm"), "ci", "--no-audit", "--no-fund", "--no-progress"], sidecar, {
      env: { PATH: `${nodeBin}:${process.env.PATH ?? ""}` },
    });

    // u-brain-login / u-brain-brand / u-brain-reference 是 file: 依赖，npm 装成指向 ../plugins 的符号链接；
    // 打进 .app 时换成真实目录，不依赖资源复制是否保留链接。
    for (const plugin of ["u-brain-login", "u-brain-brand", "u-brain-reference"]) {
      const link = join(modules, plugin);
      await rm(link, { recursive: true, force: true });
      await cp(join(sidecar, "plugins", plugin), link, { recursive: true });
    }

    const before = await dirBytes(modules);
    await prune(modules);
    console.log(JSON.stringify({ modulesBefore: mb(before), modulesAfter: mb(await dirBytes(modules)) }));
    // 缓存目录和 dist/daemon 在同一个磁盘上，可以直接移动。
    await rename(modules, out);
  },
});

await copyFile(node.path, join(outDir, "node"));
await chmod(join(outDir, "node"), 0o755);

console.log(
  JSON.stringify({
    triple,
    out: outDir,
    node: node.version.join("."),
    nodeBinary: mb((await stat(join(outDir, "node"))).size),
    total: mb(await dirBytes(outDir)),
  }),
);
