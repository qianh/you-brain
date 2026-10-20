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
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REPO=$(CDPATH= cd -- "$ROOT/../.." && pwd)
VENDOR="$REPO/dist/daemon/aarch64-apple-darwin/vendor"
WEB="$REPO/dist/daemon/aarch64-apple-darwin/web"
TARGET_TRIPLE=aarch64-apple-darwin
APP_NAME=you-brain.app
DEST_DIR="$REPO/dist/app.noindex"
TARGET_ROOT="$ROOT/src-tauri/target"
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

built_target=$TARGET_TRIPLE
has_target=0
prev=
for arg in "$@"; do
  if [ "$prev" = "--target" ]; then
    built_target=$arg
    has_target=1
  fi
  case "$arg" in
    --target=*)
      built_target=${arg#--target=}
      has_target=1
      ;;
  esac
  prev=$arg
done
if [ "$has_target" -eq 0 ]; then
  set -- --target "$TARGET_TRIPLE" "$@"
fi

remove_stale_apps

if [ -d "$VENDOR" ] && [ -d "$WEB" ]; then
  bunx tauri build --config src-tauri/tauri.bundle.conf.json "$@"
else
  echo "you-brain: $VENDOR or $WEB is missing; bundling without those resources" >&2
  bunx tauri build "$@"
fi

APP_TRIPLE="$TARGET_ROOT/$built_target/release/bundle/macos/$APP_NAME"
APP_HOST="$TARGET_ROOT/release/bundle/macos/$APP_NAME"
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
