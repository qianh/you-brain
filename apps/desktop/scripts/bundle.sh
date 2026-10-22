#!/bin/sh
# Package the menu-bar shell. `tauri dev` and `cargo check` do not load
# tauri.bundle.conf.json, so a missing dist tree cannot fail a dev build.
# When both directories exist, they are copied to Resources/vendor and Resources/web.
#
# dist/daemon and binaries/you-brain-aarch64-apple-darwin are the arm64 daemon.
# Always target that triple unless the caller passed --target, so externalBin
# does not pick the x86_64 placeholder when rustup's default host is x86_64.
#
# Publish a single you-brain.app at $REPO/dist/app.noindex/. The .noindex suffix
# keeps Spotlight from indexing the build tree. Nothing under target/ is left
# as an .app, and this script never writes /Applications.
#
# DMG packaging shells out to Finder. If that step fails after a new .app is on
# disk, keep the .app and exit 0. rw.*.dmg leftovers and /Volumes/you-brain*
# mounts are removed on the way out (success or failure).
#
# tauri.bundle.conf.json sets macOS signingIdentity to "-" (ad-hoc) and turns
# hardened runtime off. Tauri signs the .app before it builds the DMG. If that
# signature still fails `codesign --verify --deep --strict`, this script
# re-signs the .app with `codesign --force --deep --sign -` and replaces any
# product DMG so the disk image contains that signed .app.
#
# ROOT, REPO, and VOLUMES_ROOT may be set by tests. Unset, ROOT is this app
# directory, REPO is the repository root, and VOLUMES_ROOT is /Volumes.
set -eu

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

VENDOR="$REPO/dist/daemon/aarch64-apple-darwin/vendor"
WEB="$REPO/dist/daemon/aarch64-apple-darwin/web"
TARGET_TRIPLE=aarch64-apple-darwin
APP_NAME=you-brain.app
DEST_DIR="$REPO/dist/app.noindex"
TARGET_ROOT="$ROOT/src-tauri/target"
VOLUMES_ROOT="${VOLUMES_ROOT:-/Volumes}"
# Second resolution. A bundle written during this run is strictly newer.
SCRIPT_START=$(date +%s)
export SCRIPT_START
cd "$ROOT"

remove_tree() {
  rm -rf "$1"
}

# Drop leftover bundles before tauri build so an interrupted run cannot keep
# an older you-brain.app in the two historical locations or under dist/.
remove_stale_apps() {
  remove_tree "$TARGET_ROOT/$TARGET_TRIPLE/release/bundle/macos/$APP_NAME"
  remove_tree "$TARGET_ROOT/release/bundle/macos/$APP_NAME"
  if [ -d "$TARGET_ROOT" ]; then
    find "$TARGET_ROOT" -name "$APP_NAME" -type d -prune -exec rm -rf {} \;
  fi
  if [ -d "$REPO/dist" ]; then
    find "$REPO/dist" -name "$APP_NAME" -type d -prune -exec rm -rf {} \;
  fi
}

move_dmgs() {
  src=$1
  if [ ! -d "$src" ]; then
    return 0
  fi
  find "$src" -maxdepth 1 -name '*.dmg' -type f -exec mv -f {} "$DEST_DIR/" \;
}

# Tauri writes the .dmg next to the .app: bundle/dmg/, sometimes bundle/macos/.
move_bundle_dmgs() {
  bundle_dir=$1
  move_dmgs "$bundle_dir"
  move_dmgs "$bundle_dir/dmg"
  move_dmgs "$bundle_dir/macos"
}

is_fresh_app() {
  [ -d "$1" ] || return 1
  mtime=$(stat -f %m "$1" 2>/dev/null) || return 1
  [ "$mtime" -gt "$SCRIPT_START" ]
}

remove_matching_rw() {
  dir=$1
  depth=$2
  if [ ! -d "$dir" ]; then
    return 0
  fi
  if [ "$depth" = "1" ]; then
    find "$dir" -maxdepth 1 -name 'rw.*.dmg' -type f -exec rm -f {} \; || true
  else
    find "$dir" -name 'rw.*.dmg' -type f -exec rm -f {} \; || true
  fi
}

detach_you_brain_volumes() {
  uname_s=$(uname -s 2>/dev/null || true)
  if [ "$uname_s" != "Darwin" ]; then
    return 0
  fi
  if [ ! -d "$VOLUMES_ROOT" ]; then
    return 0
  fi
  if ! command -v hdiutil >/dev/null 2>&1; then
    return 0
  fi
  for vol in "$VOLUMES_ROOT"/you-brain*; do
    [ -d "$vol" ] || continue
    base=$(basename "$vol")
    case "$base" in
      you-brain*) ;;
      *) continue ;;
    esac
    hdiutil detach -force "$vol" >/dev/null 2>&1 || true
  done
}

cleanup_residues() {
  remove_matching_rw "$DEST_DIR" 1
  remove_matching_rw "$TARGET_ROOT" all
  detach_you_brain_volumes || true
  return 0
}

collect_product_dmgs() {
  dir=$1
  if [ ! -d "$dir" ]; then
    return 0
  fi
  find "$dir" -maxdepth 1 -name '*.dmg' -type f | while IFS= read -r dmg; do
    base=$(basename "$dmg")
    case "$base" in
      rw.*.dmg) ;;
      *) printf '%s\n' "$dmg" ;;
    esac
  done
}

# Product DMGs were copied from the pre-resign .app. Drop them and write one
# disk image from the signed bundle. A failed create still leaves no stale DMG.
replace_product_dmgs() {
  app=$1
  bundle_dir=$2
  list=$(mktemp "${TMPDIR:-/tmp}/you-brain-dmg-list.XXXXXX")
  collect_product_dmgs "$bundle_dir" >>"$list"
  collect_product_dmgs "$bundle_dir/dmg" >>"$list"
  collect_product_dmgs "$bundle_dir/macos" >>"$list"
  if [ ! -s "$list" ]; then
    rm -f "$list"
    return 0
  fi
  first=$(sed -n '1p' "$list")
  while IFS= read -r dmg; do
    [ -n "$dmg" ] || continue
    rm -f "$dmg"
  done <"$list"
  rm -f "$list"
  if ! command -v hdiutil >/dev/null 2>&1; then
    echo "you-brain: hdiutil 不在 PATH，已丢弃重签前的 DMG" >&2
    return 0
  fi
  mkdir -p "$(dirname "$first")"
  if ! hdiutil create -volname you-brain -srcfolder "$app" -ov -format UDZO "$first"; then
    echo "you-brain: 重签后的 DMG 生成失败，已丢弃旧 DMG" >&2
    rm -f "$first"
  fi
}

# Tauri's ad-hoc signature does not individually sign Mach-O under Resources.
# When --deep --strict fails, re-sign the whole bundle in place.
ensure_adhoc_signature() {
  app=$1
  bundle_dir=$2
  if ! command -v codesign >/dev/null 2>&1; then
    echo "you-brain: codesign 不在 PATH，跳过整包签名复查" >&2
    return 0
  fi
  if codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    return 0
  fi
  echo "you-brain: Tauri 签名未通过 codesign --verify --deep --strict，改为整包 ad-hoc 重签" >&2
  if command -v xattr >/dev/null 2>&1; then
    xattr -cr "$app" || true
  fi
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app"
  replace_product_dmgs "$app" "$bundle_dir"
}

trap cleanup_residues EXIT

built_target=$TARGET_TRIPLE
has_target=0
bundles_app_only=0
prev=
for arg in "$@"; do
  if [ "$prev" = "--target" ]; then
    built_target=$arg
    has_target=1
  fi
  if [ "$prev" = "--bundles" ] && [ "$arg" = "app" ]; then
    bundles_app_only=1
  fi
  case "$arg" in
    --target=*)
      built_target=${arg#--target=}
      has_target=1
      ;;
    --bundles=app)
      bundles_app_only=1
      ;;
  esac
  prev=$arg
done
if [ "$has_target" -eq 0 ]; then
  set -- --target "$TARGET_TRIPLE" "$@"
fi

remove_stale_apps

build_status=0
if [ -d "$VENDOR" ] && [ -d "$WEB" ]; then
  bunx tauri build --config src-tauri/tauri.bundle.conf.json "$@" || build_status=$?
else
  echo "you-brain: $VENDOR or $WEB is missing; bundling without those resources" >&2
  bunx tauri build "$@" || build_status=$?
fi

APP_TRIPLE="$TARGET_ROOT/$built_target/release/bundle/macos/$APP_NAME"
APP_HOST="$TARGET_ROOT/release/bundle/macos/$APP_NAME"

if [ "$build_status" -ne 0 ]; then
  if [ "$bundles_app_only" -eq 0 ] && { is_fresh_app "$APP_TRIPLE" || is_fresh_app "$APP_HOST"; }; then
    echo "you-brain: DMG 打包失败，已回退为仅 .app" >&2
  else
    if ! is_fresh_app "$APP_TRIPLE" && ! is_fresh_app "$APP_HOST"; then
      echo "you-brain: tauri build did not produce $APP_NAME" >&2
    fi
    exit "$build_status"
  fi
fi

if [ -d "$APP_TRIPLE" ]; then
  APP_SRC=$APP_TRIPLE
  BUNDLE_DIR="$TARGET_ROOT/$built_target/release/bundle"
elif [ -d "$APP_HOST" ]; then
  APP_SRC=$APP_HOST
  BUNDLE_DIR="$TARGET_ROOT/release/bundle"
else
  echo "you-brain: tauri build did not produce $APP_NAME" >&2
  exit 1
fi

ensure_adhoc_signature "$APP_SRC" "$BUNDLE_DIR"

mkdir -p "$DEST_DIR"
# Move stale dmgs first. The bundle just produced is last, so its dmg wins.
move_bundle_dmgs "$TARGET_ROOT/release/bundle"
move_bundle_dmgs "$TARGET_ROOT/$TARGET_TRIPLE/release/bundle"
if [ "$built_target" != "$TARGET_TRIPLE" ]; then
  move_bundle_dmgs "$TARGET_ROOT/$built_target/release/bundle"
fi
move_bundle_dmgs "$BUNDLE_DIR"

remove_tree "$DEST_DIR/$APP_NAME"
mv "$APP_SRC" "$DEST_DIR/$APP_NAME"

remove_tree "$APP_TRIPLE"
remove_tree "$APP_HOST"
if [ -d "$TARGET_ROOT" ]; then
  find "$TARGET_ROOT" -name "$APP_NAME" -type d -prune -exec rm -rf {} \;
fi

FINAL="$DEST_DIR/$APP_NAME"
echo "$FINAL"
echo "osascript -e 'quit app \"you-brain\"'; rm -rf /Applications/you-brain.app; cp -R $FINAL /Applications/"
