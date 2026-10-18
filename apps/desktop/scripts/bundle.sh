#!/bin/sh
# Package the menu-bar shell. `tauri dev` and `cargo check` do not load
# tauri.bundle.conf.json, so a missing dist tree cannot fail a dev build.
# When both directories exist, they are copied to Resources/vendor and Resources/web.
#
# dist/daemon and binaries/you-brain-aarch64-apple-darwin are the arm64 daemon.
# Always target that triple unless the caller passed --target, so externalBin
# does not pick the x86_64 placeholder when rustup's default host is x86_64.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REPO=$(CDPATH= cd -- "$ROOT/../.." && pwd)
VENDOR="$REPO/dist/daemon/aarch64-apple-darwin/vendor"
WEB="$REPO/dist/daemon/aarch64-apple-darwin/web"
TARGET_TRIPLE=aarch64-apple-darwin
cd "$ROOT"

has_target=0
for arg in "$@"; do
  if [ "$arg" = "--target" ]; then
    has_target=1
  fi
done
if [ "$has_target" -eq 0 ]; then
  set -- --target "$TARGET_TRIPLE" "$@"
fi

if [ -d "$VENDOR" ] && [ -d "$WEB" ]; then
  bunx tauri build --config src-tauri/tauri.bundle.conf.json "$@"
else
  echo "you-brain: $VENDOR or $WEB is missing; bundling without those resources" >&2
  bunx tauri build "$@"
fi

# `tauri build --target` writes target/<triple>/release. Publish the same .app
# at target/release/bundle, which is where the release check looks.
if [ "$has_target" -eq 0 ]; then
  APP_SRC="$ROOT/src-tauri/target/$TARGET_TRIPLE/release/bundle/macos/you-brain.app"
  APP_DST="$ROOT/src-tauri/target/release/bundle/macos/you-brain.app"
  if [ -d "$APP_SRC" ]; then
    mkdir -p "$ROOT/src-tauri/target/release/bundle/macos"
    rm -rf "$APP_DST"
    cp -R "$APP_SRC" "$APP_DST"
  fi
fi
