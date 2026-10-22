#!/bin/sh
# Exercises apps/desktop/scripts/bundle-linux.sh with fake uname and bunx.
# Never invokes the real tauri CLI.
set -eu

HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
BUNDLE=$(CDPATH= cd -- "$HERE/.." && pwd)/bundle-linux.sh
ORIG_PATH=$PATH
WORK=
ROOT=
REPO=
REPORT=
OUT=
ERR=
rc=0
passed=0

fail() {
  echo "FAIL: $*" >&2
  if [ -n "${ERR:-}" ] && [ -f "$ERR" ]; then
    echo "--- stderr ---" >&2
    cat "$ERR" >&2
  fi
  if [ -n "${OUT:-}" ] && [ -f "$OUT" ]; then
    echo "--- stdout ---" >&2
    cat "$OUT" >&2
  fi
  exit 1
}

cleanup_work() {
  if [ -z "${WORK:-}" ] || [ ! -d "$WORK" ]; then
    return 0
  fi
  case "$WORK" in
    "${TMPDIR:-/tmp}"/*|/tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*)
      rm -rf "$WORK"
      ;;
    *)
      echo "refuse to remove unexpected WORK=$WORK" >&2
      exit 1
      ;;
  esac
}

trap cleanup_work EXIT

setup() {
  cleanup_work
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/you-brain-bundle-linux-test.XXXXXX")
  WORK=$(CDPATH= cd -- "$WORK" && pwd)
  ROOT=$WORK/desktop
  REPO=$WORK/repo
  REPORT=$WORK/report
  OUT=$WORK/out
  ERR=$WORK/err
  bin=$WORK/bin
  mkdir -p "$ROOT/src-tauri/binaries" "$REPO/dist/app.noindex" "$bin" "$REPORT"
  : > "$ERR"
  : > "$OUT"

  cat > "$bin/uname" << 'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
  -s) printf '%s\n' "${UNAME_S:?}" ;;
  -m) printf '%s\n' "${UNAME_M:?}" ;;
  *)
    echo "unexpected uname $*" >&2
    exit 99
    ;;
esac
EOF

  cat > "$bin/bunx" << 'EOF'
#!/bin/sh
set -eu
report=${BUNX_REPORT:?}
printf '%s\n' "$*" > "$report/args"
if [ "${1:-}" != "tauri" ] || [ "${2:-}" != "build" ]; then
  echo "unexpected bunx args: $*" >&2
  exit 99
fi
target=
config=
prev=
for arg in "$@"; do
  if [ "$prev" = "--target" ]; then
    target=$arg
  fi
  if [ "$prev" = "--config" ]; then
    config=$arg
  fi
  prev=$arg
done
if [ -z "$target" ] || [ -z "$config" ] || [ ! -f "$config" ]; then
  echo "bunx missing --target or --config" >&2
  exit 97
fi
cp "$config" "$report/config.json"
root=${ROOT:?}
bundle="$root/src-tauri/target/$target/release/bundle"
mkdir -p "$bundle/deb" "$bundle/appimage"
printf '%s\n' deb > "$bundle/deb/you-brain_0.1.0_test.deb"
printf '%s\n' appimage > "$bundle/appimage/you-brain_0.1.0_test.AppImage"
EOF
  chmod +x "$bin/uname" "$bin/bunx"
  export ROOT REPO BUNX_REPORT="$REPORT"
  export PATH="$bin:$ORIG_PATH"
}

prepare_inputs() {
  triple=$1
  mkdir -p "$REPO/dist/daemon/$triple/vendor" "$REPO/dist/daemon/$triple/web"
  printf '%s\n' sidecar > "$ROOT/src-tauri/binaries/you-brain-$triple"
}

run_bundle() {
  set +e
  sh "$BUNDLE" >"$OUT" 2>"$ERR"
  rc=$?
  set -e
}

assert_not_called() {
  if [ -f "$REPORT/args" ]; then
    fail "$1: bunx was invoked"
  fi
}

pass() {
  passed=$((passed + 1))
  echo "ok: $1"
}

assert_config() {
  triple=$1
  label=$2
  if [ ! -f "$REPORT/config.json" ]; then
    fail "$label: config was not captured"
  fi
  expected=$WORK/expected.json
  cat > "$expected" << EOF
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
  if ! cmp -s "$expected" "$REPORT/config.json"; then
    echo "--- expected ---" >&2
    cat "$expected" >&2
    echo "--- actual ---" >&2
    cat "$REPORT/config.json" >&2
    fail "$label: generated config mismatch"
  fi
  if grep -F "libwebkit2gtk" "$REPORT/config.json" >/dev/null; then
    fail "$label: deb depends were duplicated"
  fi
  if grep -F -- "--config src-tauri/tauri.bundle.conf.json" "$REPORT/args" >/dev/null; then
    fail "$label: macOS bundle config was passed"
  fi
  args=$(cat "$REPORT/args")
  case "$args" in
    *"$ROOT/src-tauri/target/"*) fail "$label: config lives under src-tauri/target" ;;
  esac
}

assert_published() {
  label=$1
  deb="$REPO/dist/app.noindex/you-brain_0.1.0_test.deb"
  image="$REPO/dist/app.noindex/you-brain_0.1.0_test.AppImage"
  [ -f "$deb" ] || fail "$label: deb was not copied"
  [ -f "$image" ] || fail "$label: AppImage was not copied"
  [ "$(cat "$deb")" = "deb" ] || fail "$label: deb contents mismatch"
  [ "$(cat "$image")" = "appimage" ] || fail "$label: AppImage contents mismatch"
  if ! grep -F -x "$deb" "$OUT" >/dev/null; then
    fail "$label: stdout missing deb path"
  fi
  if ! grep -F -x "$image" "$OUT" >/dev/null; then
    fail "$label: stdout missing AppImage path"
  fi
}

# 1. x86_64 maps to the gnu triple and the generated config is passed through.
setup
export UNAME_S=Linux UNAME_M=x86_64
prepare_inputs x86_64-unknown-linux-gnu
run_bundle
[ "$rc" -eq 0 ] || fail "x86_64: exit $rc"
if ! grep -F -- "--bundles deb,appimage" "$REPORT/args" >/dev/null; then
  fail "x86_64: bundles flag missing"
fi
if ! grep -F -- "--target x86_64-unknown-linux-gnu" "$REPORT/args" >/dev/null; then
  fail "x86_64: target missing"
fi
assert_config x86_64-unknown-linux-gnu "x86_64"
assert_published "x86_64"
pass "x86_64"

# 2. aarch64 uses its own triple in the resource paths.
setup
export UNAME_S=Linux UNAME_M=aarch64
prepare_inputs aarch64-unknown-linux-gnu
run_bundle
[ "$rc" -eq 0 ] || fail "aarch64: exit $rc"
if ! grep -F -- "--target aarch64-unknown-linux-gnu" "$REPORT/args" >/dev/null; then
  fail "aarch64: target missing"
fi
assert_config aarch64-unknown-linux-gnu "aarch64"
assert_published "aarch64"
pass "aarch64"

# 3. Missing daemon outputs name the build command and do not call tauri.
setup
export UNAME_S=Linux UNAME_M=x86_64
run_bundle
[ "$rc" -eq 1 ] || fail "missing: exit $rc"
assert_not_called "missing"
if ! grep -F "bun run build:daemon" "$ERR" >/dev/null; then
  fail "missing: stderr did not mention bun run build:daemon"
fi
pass "missing outputs"

# 4. Directories without the sidecar still fail.
setup
export UNAME_S=Linux UNAME_M=x86_64
mkdir -p "$REPO/dist/daemon/x86_64-unknown-linux-gnu/vendor" \
  "$REPO/dist/daemon/x86_64-unknown-linux-gnu/web"
run_bundle
[ "$rc" -eq 1 ] || fail "missing sidecar: exit $rc"
assert_not_called "missing sidecar"
if ! grep -F "you-brain-x86_64-unknown-linux-gnu" "$ERR" >/dev/null; then
  fail "missing sidecar: stderr did not name the sidecar"
fi
pass "missing sidecar"

# 5. Non-Linux exits 2 before looking at the tree.
setup
export UNAME_S=Darwin UNAME_M=arm64
prepare_inputs aarch64-apple-darwin
run_bundle
[ "$rc" -eq 2 ] || fail "darwin: exit $rc"
assert_not_called "darwin"
if ! grep -F "只能在 Linux 上运行" "$ERR" >/dev/null; then
  fail "darwin: missing friendly error"
fi
if ! grep -F "Darwin" "$ERR" >/dev/null; then
  fail "darwin: error did not name the current OS"
fi
pass "non-linux"

# 6. An unknown machine is not guessed into a triple.
setup
export UNAME_S=Linux UNAME_M=armv7l
run_bundle
[ "$rc" -eq 2 ] || fail "armv7l: exit $rc"
assert_not_called "armv7l"
if ! grep -F "不支持的架构 armv7l" "$ERR" >/dev/null; then
  fail "armv7l: missing arch error"
fi
pass "unknown arch"

echo "bundle-linux.test.sh: $passed passed, 0 failed"
