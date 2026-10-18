#!/bin/bash
set -u
ROOT="/Users/john/private/ai/you-brain"
M0="$ROOT/.orchestration/m0"
BIN="$M0/bin"
CACHE="$M0/cache"
mkdir -p "$BIN"
ln -sfn ../node_modules "$BIN/node_modules"

run_case() {
  local name="$1"
  local bin="$2"
  local log="$M0/logs/${name}.log"
  echo "RUN $name"
  if M0_CACHE="$CACHE" "$bin" >"$log" 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name exit=$?"
  fi
  echo "---- $name ----"
  cat "$log"
  echo
}

echo "BUILD sharp-bundled"
if bun build --target=bun --compile --outfile "$BIN/sharp-bundled" "$M0/sharp-check.ts" >"$M0/logs/build-sharp-bundled.log" 2>&1; then
  echo "BUILD_PASS sharp-bundled"
  run_case sharp-bundled "$BIN/sharp-bundled"
else
  echo "BUILD_FAIL sharp-bundled"
  cat "$M0/logs/build-sharp-bundled.log"
fi

echo "BUILD sharp-external"
if bun build --target=bun --compile --packages=external --outfile "$BIN/sharp-external" "$M0/sharp-check.ts" >"$M0/logs/build-sharp-external.log" 2>&1; then
  echo "BUILD_PASS sharp-external"
  run_case sharp-external "$BIN/sharp-external"
  echo "RUN sharp-external from packages/core"
  if (cd "$ROOT/packages/core" && M0_CACHE="$CACHE" "$BIN/sharp-external") >"$M0/logs/sharp-external-core-cwd.log" 2>&1; then
    echo "PASS sharp-external-core-cwd"
  else
    echo "FAIL sharp-external-core-cwd exit=$?"
  fi
  cat "$M0/logs/sharp-external-core-cwd.log"
  echo
else
  echo "BUILD_FAIL sharp-external"
  cat "$M0/logs/build-sharp-external.log"
fi

echo "BUILD e5-external"
if bun build --target=bun --compile --packages=external --outfile "$BIN/e5-external" "$M0/e5-check.ts" >"$M0/logs/build-e5-external.log" 2>&1; then
  echo "BUILD_PASS e5-external"
  run_case e5-external "$BIN/e5-external"
else
  echo "BUILD_FAIL e5-external"
  cat "$M0/logs/build-e5-external.log"
fi

echo "BUILD e5-bundled"
if bun build --target=bun --compile --outfile "$BIN/e5-bundled" "$M0/e5-check.ts" >"$M0/logs/build-e5-bundled.log" 2>&1; then
  echo "BUILD_PASS e5-bundled"
  run_case e5-bundled "$BIN/e5-bundled"
else
  echo "BUILD_FAIL e5-bundled"
  cat "$M0/logs/build-e5-bundled.log"
fi
