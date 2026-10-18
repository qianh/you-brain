import { chmod, copyFile, cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.execPath;

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

async function run(args: string[], cwd: string): Promise<void> {
  console.log(`$ ${args.join(" ")}`);
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0] ?? "command"} 退出 ${code}`);
}

const triple = hostTriple();
const outDir = join(root, "dist", "daemon", triple);
const outfile = join(outDir, "you-brain");
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await run(
  [
    bun,
    "build",
    join(root, "packages/cli/src/index.ts"),
    "--compile",
    "--target=bun",
    "--outfile",
    outfile,
    "--external",
    "@huggingface/transformers",
    "--external",
    "sharp",
    "--external",
    "onnxruntime-node",
  ],
  root,
);
await chmod(outfile, 0o755);

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
