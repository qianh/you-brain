/**
 * Installs the built daemon into a local `you-brain.app` for ad-hoc testing.
 *
 * Replaces the three paths wholesale instead of copying over them: `cp -R src dest`
 * puts `src` *inside* an existing `dest`, which silently produced
 * `Resources/web/web/...` and `Resources/vendor/vendor/...` after a couple of installs.
 *
 * The app is re-signed ad-hoc afterwards, which changes its code signature: macOS then
 * refuses the existing keychain item, so a Google account signed in before the install
 * has to sign in once more.
 *
 * Usage: bun scripts/install-app.ts [path/to/you-brain.app]
 */
import { cp, rm, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const built = join(root, "dist", "daemon", triple);
const app = resolve(process.argv[2] ?? "/Applications/you-brain.app");

if (process.platform !== "darwin") {
  console.error("这个脚本只处理 macOS 的 .app；Linux 用 apps/desktop/scripts/bundle-linux.sh");
  process.exit(2);
}

async function run(args: string[]): Promise<void> {
  console.log(`$ ${args.join(" ")}`);
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0] ?? "command"} 退出 ${code}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

for (const name of ["you-brain", "web", "vendor"]) {
  if (!(await exists(join(built, name)))) {
    console.error(`缺少 ${join(built, name)}，先运行 bun run build:daemon`);
    process.exit(2);
  }
}
if (!(await exists(app))) {
  console.error(`找不到 ${app}`);
  process.exit(2);
}

// Stop the running copy so its files can be replaced.
await run(["pkill", "-TERM", "-f", `${app}/Contents/MacOS/you-brain`]).catch(() => undefined);
await Bun.sleep(3_000);

const staging = await mkdtemp(join(tmpdir(), "you-brain-app-"));
const resources = join(app, "Contents", "Resources");
const binaries = join(app, "Contents", "MacOS");

// Replace, never merge: a leftover `web/web` would keep serving stale assets.
await rm(join(resources, "web"), { recursive: true, force: true });
await rm(join(resources, "vendor"), { recursive: true, force: true });
await cp(join(built, "web"), join(staging, "web"), { recursive: true, dereference: true });
await cp(join(built, "vendor"), join(staging, "vendor"), { recursive: true, dereference: true });
await cp(join(staging, "web"), join(resources, "web"), { recursive: true, dereference: true });
await cp(join(staging, "vendor"), join(resources, "vendor"), { recursive: true, dereference: true });
await rm(staging, { recursive: true, force: true });

await cp(join(built, "you-brain"), join(binaries, "you-brain"));
await run(["chmod", "755", join(binaries, "you-brain")]);

await run(["codesign", "--force", "--deep", "--sign", "-", app]);
await run(["codesign", "--verify", "--deep", "--strict", app]);
console.log(JSON.stringify({ app, triple, signed: "ad-hoc" }));
