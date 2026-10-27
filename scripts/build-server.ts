/**
 * 服务器端分发：把编译好的 daemon、Web 界面和 vendor 打成一个 tar.gz。
 *
 * 与桌面端的区别：没有 Tauri 外壳，没有菜单栏，没有打包成 deb/AppImage。
 * 产物解压后是
 *
 *   you-brain-<version>-<triple>/
 *     bin/you-brain
 *     lib/you-brain/web/...
 *     lib/you-brain/vendor/node_modules/...
 *     install.sh
 *
 * `bin` + `lib/you-brain` 这个布局和 Linux 桌面包一致，所以
 * `resolveWebDir` 与 `vendorNodeModulesDir` 里的 `../lib/<productName>` 兜底能直接用，
 * 不需要额外的环境变量。
 *
 * 只能在目标平台上跑：`bun build --compile` 不能交叉编译，vendor 里的
 * onnxruntime-node / sharp 是本机原生二进制。所以在 Linux 机器或 Linux CI 上执行。
 *
 * `--allow-non-linux` 只用于本地验证打包流程（目录结构、tar、install.sh 文本），
 * 产物不能拿去当服务器包。
 *
 * 用法：bun scripts/build-server.ts [--skip-daemon] [--allow-non-linux]
 */
import { chmod, copyFile, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.execPath;
const skipDaemon = process.argv.includes("--skip-daemon");
const allowNonLinux = process.argv.includes("--allow-non-linux");

function hostTriple(): string {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  if (allowNonLinux && process.platform === "darwin") return `${arch}-apple-darwin`;
  throw new Error(
    `服务器包只能在 Linux 上构建（当前 ${process.platform}）。` +
      "本地只想验证打包流程时加 --allow-non-linux。",
  );
}

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

const INSTALL_SH = `#!/bin/sh
# you-brain 服务器端安装。解压后执行：./install.sh
# 自定义前缀：PREFIX=/opt/you-brain ./install.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
PREFIX=\${PREFIX:-$HOME/.local}
bindir="$PREFIX/bin"
libdir="$PREFIX/lib/you-brain"

os=$(uname -s 2>/dev/null || printf '%s\\n' unknown)
if [ "$os" != "Linux" ]; then
  echo "you-brain: 这个包只用于 Linux（当前 \${os}）。" >&2
  exit 2
fi

if [ ! -f "$here/bin/you-brain" ]; then
  echo "you-brain: 包里缺少 bin/you-brain，请重新解压。" >&2
  exit 2
fi

mkdir -p "$bindir" "$PREFIX/lib"
# 整体替换而不是覆盖复制：旧的 web/vendor 残留会让 daemon 读到过期资源。
rm -rf "$libdir"
cp -R "$here/lib/you-brain" "$libdir"
install -m 755 "$here/bin/you-brain" "$bindir/you-brain"

echo "已安装到 $bindir/you-brain"
echo "界面与原生依赖：$libdir"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "注意：这台机器没有 systemctl，只能用前台方式运行：$bindir/you-brain daemon"
  exit 0
fi

cat <<'NEXT'

下一步：
  1. 首次设置（无界面，会打印 SSH 隧道命令用于 Google 登录）
       you-brain setup --server --yes
     走自己的 Google Cloud 项目（不依赖内置凭据，不受测试用户数限制）：
       you-brain setup --server --oauth custom \
         --client-id <xxx.apps.googleusercontent.com> --client-secret <secret>
     也可以先跑上面的 --yes 把服务装起来，再在设置页「账户与 Drive → OAuth 凭据」里填。
  2. 安装开机自启（systemd 用户单元）
       you-brain service install
     无人登录也要常驻，需要 root 执行：
       loginctl enable-linger $USER
  3. 设为主设备
       you-brain devices --set-main <这台设备的 id>

自己的 OAuth 项目：Google Cloud Console 建项目 → 启用 Google Drive API →
创建「桌面应用」类型的 OAuth 客户端。User type 选 Internal（同 Workspace 域名）
或发布到 Production；停在 Testing 时授权每 7 天过期。

Web 界面只监听 127.0.0.1。远程查看请用 SSH 端口转发或 Tailscale，
不要把端口直接对外。端口在 setup 后由 you-brain status 打印。
NEXT
`;

const triple = hostTriple();
const built = join(root, "dist", "daemon", triple);

if (!skipDaemon) {
  await run([bun, "run", "build:daemon"]);
} else if (!(await exists(join(built, "you-brain")))) {
  throw new Error(`缺少 ${join(built, "you-brain")}，先运行 bun run build:daemon`);
}

for (const name of ["you-brain", "web", "vendor"]) {
  if (!(await exists(join(built, name)))) {
    throw new Error(`缺少 ${join(built, name)}，先运行 bun run build:daemon`);
  }
}

const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text()) as { version?: string };
const version = pkg.version ?? "0.0.0";
const name = `you-brain-${version}-${triple}`;
const staging = join(root, "dist", "server", name);
const tarball = join(root, "dist", "server", `${name}.tar.gz`);

await rm(staging, { recursive: true, force: true });
await mkdir(join(staging, "bin"), { recursive: true });
await mkdir(join(staging, "lib"), { recursive: true });

await copyFile(join(built, "you-brain"), join(staging, "bin", "you-brain"));
await chmod(join(staging, "bin", "you-brain"), 0o755);
await cp(join(built, "web"), join(staging, "lib", "you-brain", "web"), {
  recursive: true,
  dereference: true,
});
await cp(join(built, "vendor"), join(staging, "lib", "you-brain", "vendor"), {
  recursive: true,
  dereference: true,
});

await Bun.write(join(staging, "install.sh"), INSTALL_SH);
await chmod(join(staging, "install.sh"), 0o755);

await rm(tarball, { force: true });
// `-C dist/server` 让压缩包里只有一个顶层目录，解压不会污染当前目录。
await run(["tar", "-czf", tarball, "-C", join(root, "dist", "server"), name]);

const files = await readdir(staging);
console.log(
  JSON.stringify({
    triple,
    version,
    staging,
    tarball,
    files,
    bytes: (await stat(tarball)).size,
  }),
);

/**
 * 安装脚本。默认装到 `~/.local`，可以用 `PREFIX=/opt/you-brain` 覆盖。
 *
 * 不碰 sudo：装到系统目录时由用户自己决定前缀和权限。不写 systemd 单元，
 * 单元由 `you-brain service install` 生成，路径与 `you-brain uninstall` 的清理逻辑一致。
 */
