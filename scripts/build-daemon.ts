import { readdir, readFile } from "node:fs/promises";
import { chmod, copyFile, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  officialOAuthDefine,
  parseReleaseEnv,
  resolveBuildOAuthCredentials,
  type OfficialOAuthCredentials,
} from "./official-oauth.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.execPath;
const JUNK_DIR = new Set([
  "test",
  "tests",
  "__tests__",
  "docs",
  "example",
  "examples",
  "benchmark",
  "benchmarks",
]);
const JUNK_FILE = /^(?:readme|changelog|history|contributing)(?:\.|$)/iu;
const JUNK_EXT = /\.(?:map|ts|tsx|mts|cts)$/iu;

function hostTriple(): string {
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  throw new Error(`不支持的平台 ${process.platform}/${process.arch}`);
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** `display` overrides the echoed command so secrets never reach a log. */
async function run(args: string[], cwd: string, display = args.join(" ")): Promise<void> {
  console.log(`$ ${display}`);
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0] ?? "command"} 退出 ${code}`);
}

const releaseEnv = await readReleaseEnv();
const oauth = resolveBuildOAuthCredentials({ env: process.env, releaseEnv });
if (oauth.warning) {
  console.error("\n========================================");
  console.error(`警告：${oauth.warning}`);
  console.error("========================================\n");
}
const define = officialOAuthDefine(oauth.credentials);

const triple = hostTriple();
const outDir = join(root, "dist", "daemon", triple);
const outfile = join(outDir, "you-brain");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await compileDaemon(outfile, define);
await chmod(outfile, 0o755);
if (oauth.credentials) {
  await assertOAuthInjected(outfile, oauth.credentials);
  console.log("已注入官方 OAuth 凭据");
}

const vendorRoot = await mkdtemp(join(tmpdir(), "you-brain-vendor-"));
try {
  await Bun.write(
    join(vendorRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "you-brain-vendor",
        private: true,
        dependencies: {
          "@huggingface/transformers": "4.3.1",
          sharp: "0.34.5",
          "onnxruntime-node": "1.30.0",
        },
        trustedDependencies: [
          "sharp",
          "onnxruntime-node",
          "protobufjs",
          "@huggingface/transformers",
        ],
      },
      null,
      2,
    )}\n`,
  );
  await run([bun, "install"], vendorRoot);
  const vendorModules = join(outDir, "vendor", "node_modules");
  await mkdir(join(outDir, "vendor"), { recursive: true });
  await cp(join(vendorRoot, "node_modules"), vendorModules, {
    recursive: true,
    dereference: true,
  });
  for (const name of ["sharp", "@huggingface/transformers", "onnxruntime-node"]) {
    if (!(await isDir(join(vendorModules, name)))) {
      throw new Error(`vendor 缺少 ${name}`);
    }
  }
  const before = await dirBytes(join(outDir, "vendor"));
  await pruneVendor(vendorModules, triple);
  const after = await dirBytes(join(outDir, "vendor"));
  console.log(
    JSON.stringify({
      vendorBefore: formatBytes(before),
      vendorAfter: formatBytes(after),
    }),
  );
} finally {
  await rm(vendorRoot, { recursive: true, force: true });
}

const webDist = join(root, "apps/web/dist");
if (await isDir(webDist)) {
  await cp(webDist, join(outDir, "web"), { recursive: true, dereference: true });
  console.log(`copied ${webDist} -> ${join(outDir, "web")}`);
} else {
  console.log("apps/web/dist 不存在，跳过 web/");
}

const binaries = join(root, "apps/desktop/src-tauri/binaries");
await mkdir(binaries, { recursive: true });
const sidecar = join(binaries, `you-brain-${triple}`);
await copyFile(outfile, sidecar);
await chmod(sidecar, 0o755);

console.log(
  JSON.stringify({
    triple,
    outfile,
    vendor: join(outDir, "vendor", "node_modules"),
    web: join(outDir, "web"),
    sidecar,
  }),
);

async function readReleaseEnv(): Promise<Record<string, string>> {
  const path = join(homedir(), ".config", "you-brain", "release.env");
  try {
    return parseReleaseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Compiles the daemon through the `bun build` CLI rather than `Bun.build`.
 *
 * `Bun.build({ compile: { outfile } })` returned success without writing the executable
 * on bun 1.2.19 (the output stayed a plain `entry.js`), while the CLI has produced the
 * same artifact on every version. The CLI also defaults to `--env=disable`, so the
 * build machine's environment is still never inlined: official credentials enter only
 * through `--define`, which rewrites the bundled env reads.
 */
async function compileDaemon(
  outfile: string,
  define: Record<string, string> | undefined,
): Promise<void> {
  const external = ["@huggingface/transformers", "sharp", "onnxruntime-node"];
  const args = [
    bun,
    "build",
    "--compile",
    "--target=bun",
    `--outfile=${outfile}`,
    `--root=${root}`,
    ...external.map((name) => `--external=${name}`),
    ...Object.entries(define ?? {}).map(([key, value]) => `--define=${key}=${value}`),
    join(root, "packages/cli/src/index.ts"),
  ];
  // The `--define` values carry the official OAuth client secret. Echo the shape of the
  // command, never the values, so a CI log cannot leak them.
  const shown = args.slice(1).map((arg) =>
    arg.startsWith("--define=") ? `--define=${arg.slice("--define=".length).split("=")[0]}=***` : arg,
  );
  await run(args, root, shown.join(" "));
}

async function assertOAuthInjected(
  outfile: string,
  credentials: OfficialOAuthCredentials,
): Promise<void> {
  const text = Buffer.from(await Bun.file(outfile).arrayBuffer()).toString("latin1");
  if (!text.includes(credentials.clientId)) {
    throw new Error("编译产物中没有找到官方 OAuth client id");
  }
  if (!text.includes(credentials.clientSecret)) {
    throw new Error("编译产物中没有找到官方 OAuth client secret");
  }
}

function hostNative(triple: string): { platform: string; arch: string } {
  if (triple.startsWith("aarch64-") && triple.endsWith("apple-darwin")) {
    return { platform: "darwin", arch: "arm64" };
  }
  if (triple.startsWith("x86_64-") && triple.endsWith("apple-darwin")) {
    return { platform: "darwin", arch: "x64" };
  }
  if (triple.startsWith("aarch64-") && triple.endsWith("linux-gnu")) {
    return { platform: "linux", arch: "arm64" };
  }
  if (triple.startsWith("x86_64-") && triple.endsWith("linux-gnu")) {
    return { platform: "linux", arch: "x64" };
  }
  throw new Error(`无法映射原生二进制目录 ${triple}`);
}

async function pruneVendor(vendorModules: string, triple: string): Promise<void> {
  const native = hostNative(triple);
  await keepOnnxHost(join(vendorModules, "onnxruntime-node", "bin"), native);
  // CUDA/TensorRT 执行 provider 是 GPU 专用插件，CPU 模式不加载；AppImage 的
  // linuxdeploy 还会因为它们声明依赖 CUDA libcublas 而拒绝打包。Mac 的 vendor
  // 里本来就没有这几个文件，删不到时是空操作。
  const onnxHostDir = join(
    vendorModules,
    "onnxruntime-node",
    "bin",
    "napi-v6",
    native.platform,
    native.arch,
  );
  for (const provider of ["libonnxruntime_providers_cuda.so", "libonnxruntime_providers_tensorrt.so"]) {
    await rm(join(onnxHostDir, provider), { force: true });
  }
  await rm(join(vendorModules, "onnxruntime-web"), { recursive: true, force: true });
  await rm(join(vendorModules, "onnxruntime-node", "script"), { recursive: true, force: true });
  await rm(join(vendorModules, "onnxruntime-node", "lib"), { recursive: true, force: true });
  await rm(join(vendorModules, "@types"), { recursive: true, force: true });
  await rm(join(vendorModules, "undici-types"), { recursive: true, force: true });
  const transformers = join(vendorModules, "@huggingface", "transformers");
  await rm(join(transformers, "src"), { recursive: true, force: true });
  await rm(join(transformers, "types"), { recursive: true, force: true });
  // The node build imports sharp and onnxruntime-node by name. The hoisted copies are enough.
  await rm(join(transformers, "node_modules"), { recursive: true, force: true });
  for (const name of ["transformers.web.js", "transformers.min.js"]) {
    await rm(join(transformers, "dist", name), { force: true });
  }
  await keepSharpHost(join(vendorModules, "@img"), native);
  await stripJunk(vendorModules);
  const binding = join(
    vendorModules,
    "onnxruntime-node",
    "bin",
    "napi-v6",
    native.platform,
    native.arch,
    "onnxruntime_binding.node",
  );
  if (!(await isFile(binding))) throw new Error(`缺少目标平台 onnxruntime 二进制 ${binding}`);
  if (await isDir(join(vendorModules, "onnxruntime-web"))) {
    throw new Error("onnxruntime-web 应该已被删除");
  }
}

async function keepOnnxHost(
  binRoot: string,
  native: { platform: string; arch: string },
): Promise<void> {
  let napis: string[] = [];
  try {
    napis = await readdir(binRoot);
  } catch {
    return;
  }
  for (const napi of napis) {
    const napiDir = join(binRoot, napi);
    let platforms: string[] = [];
    try {
      platforms = await readdir(napiDir);
    } catch {
      continue;
    }
    for (const name of platforms) {
      const platformDir = join(napiDir, name);
      if (name !== native.platform) {
        await rm(platformDir, { recursive: true, force: true });
        continue;
      }
      let arches: string[] = [];
      try {
        arches = await readdir(platformDir);
      } catch {
        continue;
      }
      for (const arch of arches) {
        if (arch !== native.arch) await rm(join(platformDir, arch), { recursive: true, force: true });
      }
    }
  }
}

async function keepSharpHost(
  imgRoot: string,
  native: { platform: string; arch: string },
): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(imgRoot);
  } catch {
    return;
  }
  const marker = `${native.platform}-${native.arch}`;
  for (const name of names) {
    if (name === "colour" || name === "color") continue;
    if (name.endsWith(marker)) continue;
    await rm(join(imgRoot, name), { recursive: true, force: true });
  }
}

async function stripJunk(root: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (JUNK_DIR.has(entry.name)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      await stripJunk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    if (JUNK_FILE.test(entry.name) || JUNK_EXT.test(entry.name)) {
      await rm(path, { force: true });
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function dirBytes(path: string): Promise<number> {
  const proc = Bun.spawn(["du", "-sk", path], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return -1;
  const kb = Number(text.trim().split(/\s+/u)[0]);
  return Number.isFinite(kb) ? kb * 1024 : -1;
}

function formatBytes(bytes: number): string {
  if (bytes < 0) return "unknown";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}
