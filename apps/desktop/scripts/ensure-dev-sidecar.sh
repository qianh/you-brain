#!/bin/sh
# Debug builds declare externalBin but the real daemon binary is packaged later.
# Drop a non-Mach-O placeholder so `tauri build --debug` can compile. Release
# builds leave a missing sidecar as a hard failure. The shell prefers a native
# sidecar and otherwise uses YOU_BRAIN_DAEMON_CMD.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TRIPLE=${TAURI_ENV_TARGET_TRIPLE:-}
if [ -z "$TRIPLE" ]; then
  TRIPLE=$(rustc --print host-tuple)
fi
DEST="$ROOT/src-tauri/binaries/you-brain-$TRIPLE"
if [ "${TAURI_ENV_DEBUG:-}" != "true" ]; then
  exit 0
fi
if [ -e "$DEST" ]; then
  exit 0
fi
mkdir -p "$ROOT/src-tauri/binaries"
printf '%s\n' '#!/bin/sh' 'echo "you-brain sidecar placeholder; set YOU_BRAIN_DAEMON_CMD" >&2' 'exit 1' > "$DEST"
chmod +x "$DEST"
