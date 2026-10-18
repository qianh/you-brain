#!/bin/sh
# Package the menu-bar shell. `tauri dev` and `cargo check` do not load
# tauri.bundle.conf.json, so a missing dist tree cannot fail a dev build.
# When both directories exist, they are copied to Resources/vendor and Resources/web.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
REPO=$(CDPATH= cd -- "$ROOT/../.." && pwd)
VENDOR="$REPO/dist/daemon/aarch64-apple-darwin/vendor"
WEB="$REPO/dist/daemon/aarch64-apple-darwin/web"
cd "$ROOT"
if [ -d "$VENDOR" ] && [ -d "$WEB" ]; then
  exec bunx tauri build --config src-tauri/tauri.bundle.conf.json "$@"
fi
echo "you-brain: $VENDOR or $WEB is missing; bundling without those resources" >&2
exec bunx tauri build "$@"
