#!/bin/sh
# Linux 桌面打包（deb + AppImage）。macOS 仍走 scripts/bundle.sh，本脚本不改它。
#
# 必须在 Linux 上跑：sidecar 与 vendor/web 由本机 `bun run build:daemon` 产出，
# `tauri build` 还要链接本机的 WebKitGTK。
#
# 不提交静态 tauri.bundle.linux.conf.json。Tauri 配置没有变量，资源路径里带
# rust triple（x86_64-unknown-linux-gnu 或 aarch64-unknown-linux-gnu）。
# 一份入库的 x86_64 示例在 aarch64 上是错的。脚本把配置写到 src-tauri/target
# 之外的临时文件，再用 --config 传入。`tauri build` 会把工作目录改到
# src-tauri，相对路径仍相对 tauri.conf.json：
# ../../../dist/daemon/<triple>/{vendor,web}。
#
# 不重复声明 deb Depends。Tauri CLI 2.12 在 Linux 上已经追加
# libwebkit2gtk-4.1-0、libgtk-3-0；启用 tray-icon 且检测到 ayatana 时再追加
# libayatana-appindicator3-1（crates/tauri-cli/src/interface/rust.rs）。
#
# 成功后把 .deb / .AppImage 复制到 $REPO/dist/app.noindex/，目录名与 macOS 相同。
# ROOT、REPO 可由测试设置。未设置时 ROOT 是 apps/desktop，REPO 是仓库根。
set -eu

config_dir=
cleanup() {
  if [ -n "${config_dir:-}" ]; then
    rm -rf "$config_dir"
  fi
}
trap cleanup EXIT

os=$(uname -s 2>/dev/null || printf '%s\n' unknown)
if [ "$os" != "Linux" ]; then
  echo "you-brain: bundle-linux.sh 只能在 Linux 上运行（当前 ${os}）。请在 Linux 机器或 GitHub Actions 上执行。" >&2
  exit 2
fi

machine=$(uname -m)
case "$machine" in
  x86_64) triple=x86_64-unknown-linux-gnu ;;
  aarch64) triple=aarch64-unknown-linux-gnu ;;
  *)
    echo "you-brain: 不支持的架构 ${machine}（仅 x86_64 与 aarch64）" >&2
    exit 2
    ;;
esac

if [ -n "${ROOT:-}" ]; then
  ROOT=$(CDPATH= cd -- "$ROOT" && pwd)
else
  ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
fi
if [ -n "${REPO:-}" ]; then
  REPO=$(CDPATH= cd -- "$REPO" && pwd)
else
  REPO=$(CDPATH= cd -- "$ROOT/../.." && pwd)
fi
export ROOT REPO

vendor="$REPO/dist/daemon/$triple/vendor"
web="$REPO/dist/daemon/$triple/web"
sidecar="$ROOT/src-tauri/binaries/you-brain-$triple"
if [ ! -d "$vendor" ] || [ ! -d "$web" ] || [ ! -f "$sidecar" ]; then
  echo "you-brain: 缺少 Linux daemon 产物（${vendor}、${web} 或 ${sidecar}）。请先运行 bun run build:daemon" >&2
  exit 1
fi

config_dir=$(mktemp -d "${TMPDIR:-/tmp}/you-brain-bundle-linux.XXXXXX")
config="$config_dir/tauri.bundle.linux.conf.json"
cat > "$config" << EOF
{
  "bundle": {
    "resources": {
      "../../../dist/daemon/${triple}/vendor": "vendor",
      "../../../dist/daemon/${triple}/web": "web"
    },
    "targets": ["deb", "appimage"]
  }
}
EOF

cd "$ROOT"
# 额外参数原样透传给 tauri build（例如 --verbose 排查打包问题）。
bunx tauri build --bundles deb,appimage --target "$triple" --config "$config" "$@"

dest="$REPO/dist/app.noindex"
mkdir -p "$dest"
target_root="$ROOT/src-tauri/target"
deb_count=0
appimage_count=0
for dir in \
  "$target_root/$triple/release/bundle/deb" \
  "$target_root/$triple/release/bundle/appimage" \
  "$target_root/release/bundle/deb" \
  "$target_root/release/bundle/appimage"
do
  if [ ! -d "$dir" ]; then
    continue
  fi
  for file in "$dir"/*.deb "$dir"/*.AppImage; do
    if [ ! -f "$file" ]; then
      continue
    fi
    cp -f "$file" "$dest/"
    echo "$dest/$(basename "$file")"
    case "$file" in
      *.deb) deb_count=$((deb_count + 1)) ;;
      *.AppImage) appimage_count=$((appimage_count + 1)) ;;
    esac
  done
done

if [ "$deb_count" -eq 0 ] || [ "$appimage_count" -eq 0 ]; then
  echo "you-brain: tauri build 没有同时产生 .deb 和 .AppImage" >&2
  exit 1
fi
