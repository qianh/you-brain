/**
 * 跨平台一键重新编译并就地部署本机（各设备拉取最新代码后统一执行 `bun run redeploy`）：
 *
 * - macOS：
 *   - 默认（未传 `--full` 且 `/Applications/U-Brain.app` 已存在）：`build:daemon` + `install:app`（约 35 秒，热替换 daemon/web/vendor/dsh 并自动重启 App）。
 *   - 传 `--full` 或 `/Applications/U-Brain.app` 不存在：走完整 Tauri `.app` 打包并替换 `/Applications/U-Brain.app`。
 * - Linux（VPS 主控 / 服务器）：
 *   - 执行 `build:server` 产出最新服务器包与 `relay/`；
 *   - 直接运行包内 `install.sh`：整体更新 `you-brain`（二进制、web、vendor），若本机装有 `u-brain-relay` 则自动同步中转源码、注销旧 Telegram Webhook、清空 `BOT_TOKEN`、检查 coturn 并重启 `u-brain-relay` 与 `you-brain` 服务。
 */
import { cp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInstall } from "./build-cache.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.execPath;
const fullBundle = process.argv.includes("--full");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function run(args: string[], cwd = root): Promise<void> {
  console.log(`$ ${args.join(" ")}`);
  const child = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0] ?? "command"} 退出 ${code}`);
}

await runInstall([bun, "install"], root, { directFirst: true });

if (process.platform === "darwin") {
  const appPath = "/Applications/U-Brain.app";
  await run([bun, "run", "build:daemon"]);
  if (!fullBundle && (await exists(appPath))) {
    await run([bun, "run", "install:app", appPath]);
  } else {
    await run([bun, "run", "--cwd", "apps/desktop", "bundle", "--bundles", "app"]);
    await run(["osascript", "-e", 'quit app "U-Brain"']).catch(() => undefined);
    await run(["pkill", "-TERM", "-f", `${appPath}/Contents/MacOS/you-brain daemon`]).catch(() => undefined);
    await Bun.sleep(2_000);
    await rm(appPath, { recursive: true, force: true });
    await cp(join(root, "dist", "app.noindex", "U-Brain.app"), appPath, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await run(["codesign", "--verify", "--deep", "--strict", appPath]);
    await run(["open", "-a", appPath]);
  }
  console.log("macOS 本机重装部署完成。");
} else if (process.platform === "linux") {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const triple = `${arch}-unknown-linux-gnu`;
  await run([bun, "run", "build:server"]);
  const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text()) as { version?: string };
  const version = pkg.version ?? "0.0.0";
  const installSh = join(root, "dist", "server", `you-brain-${version}-${triple}`, "install.sh");
  await run(["sh", installSh]);
  console.log("Linux 服务器与中转本机重装部署完成。");
} else {
  throw new Error(`不支持的平台：${process.platform}`);
}
