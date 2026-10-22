#!/bin/sh
# Exercises apps/desktop/scripts/bundle.sh with a fake bunx. Never touches the
# real dist/ tree or /Applications.
set -eu

HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
BUNDLE=$(CDPATH= cd -- "$HERE/.." && pwd)/bundle.sh
ORIG_PATH=$PATH
WORK=
ROOT=
REPO=
VOLUMES_ROOT=
REPORT=
OUT=
ERR=
HDIUTIL_LOG=
CODESIGN_LOG=
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
  if [ -n "${HDIUTIL_LOG:-}" ] && [ -f "$HDIUTIL_LOG" ]; then
    echo "--- hdiutil ---" >&2
    cat "$HDIUTIL_LOG" >&2
  fi
  if [ -n "${CODESIGN_LOG:-}" ] && [ -f "$CODESIGN_LOG" ]; then
    echo "--- codesign ---" >&2
    cat "$CODESIGN_LOG" >&2
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
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/you-brain-bundle-test.XXXXXX")
  WORK=$(CDPATH= cd -- "$WORK" && pwd)
  ROOT=$WORK/desktop
  REPO=$WORK/repo
  VOLUMES_ROOT=$WORK/volumes
  REPORT=$WORK/report
  OUT=$WORK/out
  ERR=$WORK/err
  HDIUTIL_LOG=$WORK/hdiutil.log
  CODESIGN_LOG=$WORK/codesign.log
  bin=$WORK/bin
  mkdir -p \
    "$REPO/dist/daemon/aarch64-apple-darwin/vendor" \
    "$REPO/dist/daemon/aarch64-apple-darwin/web" \
    "$REPO/dist/app.noindex" \
    "$ROOT/src-tauri" \
    "$VOLUMES_ROOT/you-brain" \
    "$VOLUMES_ROOT/you-brain-extra" \
    "$VOLUMES_ROOT/you-brain temp" \
    "$VOLUMES_ROOT/not-you-brain" \
    "$bin" \
    "$REPORT"
  echo residue > "$REPO/dist/app.noindex/rw.pre.dmg"
  echo keep > "$REPO/dist/app.noindex/keep.dmg"
  echo note > "$REPO/dist/app.noindex/rw.notdmg.txt"
  : > "$HDIUTIL_LOG"
  : > "$CODESIGN_LOG"
  CODESIGN_MODE=verify-ok

  cat > "$bin/bunx" << 'EOF'
#!/bin/sh
set -eu
report=${BUNX_REPORT:?}
printf '%s\n' "$*" > "$report/args"
if [ "${1:-}" != "tauri" ] || [ "${2:-}" != "build" ]; then
  echo "unexpected bunx args: $*" >&2
  exit 99
fi
target=aarch64-apple-darwin
prev=
for arg in "$@"; do
  if [ "$prev" = "--target" ]; then
    target=$arg
  fi
  case "$arg" in
    --target=*) target=${arg#--target=} ;;
  esac
  prev=$arg
done
root=${ROOT:?}
app="$root/src-tauri/target/$target/release/bundle/macos/you-brain.app"
bundle="$root/src-tauri/target/$target/release/bundle"
mode=${BUNX_MODE:?}

fresh_app() {
  mkdir -p "$app/Contents"
  echo fresh > "$app/Contents/marker"
  when=$((SCRIPT_START + 5))
  stamp=$(date -r "$when" +%Y%m%d%H%M.%S)
  touch -t "$stamp" "$app"
}

case "$mode" in
  success)
    mkdir -p "$bundle/macos" "$bundle/dmg" "$root/src-tauri/target/nested"
    fresh_app
    echo product > "$bundle/dmg/you-brain_0.1.0_aarch64.dmg"
    echo temp > "$bundle/rw.111.dmg"
    echo temp > "$bundle/macos/rw.222.dmg"
    echo temp > "$root/src-tauri/target/nested/rw.333.dmg"
    exit 0
    ;;
  dmg-fail)
    mkdir -p "$bundle" "$root/src-tauri/target/nested"
    fresh_app
    echo temp > "$bundle/rw.444.dmg"
    echo temp > "$root/src-tauri/target/nested/rw.555.dmg"
    exit 1
    ;;
  fail)
    mkdir -p "$root/src-tauri/target/nested"
    echo temp > "$root/src-tauri/target/nested/rw.666.dmg"
    exit 1
    ;;
  stale)
    if [ -d "$app" ]; then
      echo present > "$report/saw-app"
      exit 1
    fi
    echo absent > "$report/saw-app"
    mkdir -p "$app/Contents"
    echo rebuilt-old > "$app/Contents/marker"
    touch -t 202001010000 "$app/Contents/marker" "$app/Contents" "$app"
    exit 1
    ;;
  fresh-fail)
    mkdir -p "$bundle"
    fresh_app
    echo temp > "$bundle/rw.777.dmg"
    exit 1
    ;;
  *)
    echo "unknown mode $mode" >&2
    exit 98
    ;;
esac
EOF

  cat > "$bin/hdiutil" << 'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$HDIUTIL_LOG"
exit 1
EOF

  cat > "$bin/codesign" << 'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "${CODESIGN_LOG:?}"
case "${1:-}" in
  --verify)
    if [ "${CODESIGN_MODE:-verify-ok}" = "verify-always-fail" ]; then
      echo "fake verify failed" >&2
      exit 1
    fi
    if [ "${CODESIGN_MODE:-verify-ok}" = "verify-fail" ] && [ ! -f "${CODESIGN_LOG}.did-fail" ]; then
      : > "${CODESIGN_LOG}.did-fail"
      echo "fake verify failed" >&2
      exit 1
    fi
    exit 0
    ;;
  --force)
    exit 0
    ;;
  *)
    echo "unexpected codesign args: $*" >&2
    exit 97
    ;;
esac
EOF
  chmod +x "$bin/bunx" "$bin/hdiutil" "$bin/codesign"
  export ROOT REPO VOLUMES_ROOT HDIUTIL_LOG CODESIGN_LOG CODESIGN_MODE BUNX_REPORT="$REPORT"
  export PATH="$bin:$ORIG_PATH"
}

run_bundle() {
  set +e
  sh "$BUNDLE" "$@" >"$OUT" 2>"$ERR"
  rc=$?
  set -e
}

assert_no_rw() {
  leftovers=$(find "$WORK" -name 'rw.*.dmg' -type f 2>/dev/null || true)
  if [ -n "$leftovers" ]; then
    fail "$1: rw dmg left behind: $leftovers"
  fi
}

assert_volumes() {
  if ! grep -F -x "detach -force $VOLUMES_ROOT/you-brain" "$HDIUTIL_LOG" >/dev/null; then
    fail "$1: missing detach for you-brain"
  fi
  if ! grep -F -x "detach -force $VOLUMES_ROOT/you-brain-extra" "$HDIUTIL_LOG" >/dev/null; then
    fail "$1: missing detach for you-brain-extra"
  fi
  if ! grep -F -x "detach -force $VOLUMES_ROOT/you-brain temp" "$HDIUTIL_LOG" >/dev/null; then
    fail "$1: missing detach for you-brain temp"
  fi
  if grep -F "not-you-brain" "$HDIUTIL_LOG" >/dev/null; then
    fail "$1: detached a volume that does not start with you-brain"
  fi
  [ -d "$VOLUMES_ROOT/not-you-brain" ] || fail "$1: control volume was removed"
}

assert_kept_noise() {
  [ -f "$REPO/dist/app.noindex/keep.dmg" ] || fail "$1: keep.dmg was removed"
  [ -f "$REPO/dist/app.noindex/rw.notdmg.txt" ] || fail "$1: non-rw dmg file was removed"
}

assert_final_lines() {
  label=$1
  final=$(sed -n '1p' "$OUT")
  hint=$(sed -n '2p' "$OUT")
  extra=$(sed -n '3p' "$OUT")
  case "$final" in
    */dist/app.noindex/you-brain.app) ;;
    *) fail "$label: unexpected FINAL [$final]" ;;
  esac
  case "$final" in
    "$WORK"/*|/private"$WORK"/*) ;;
    *) fail "$label: FINAL is outside the temp repo [$final]" ;;
  esac
  expected="osascript -e 'quit app \"you-brain\"'; rm -rf /Applications/you-brain.app; cp -R $final /Applications/"
  if [ "$hint" != "$expected" ]; then
    fail "$label: install hint mismatch [$hint]"
  fi
  if [ -n "$extra" ]; then
    fail "$label: unexpected extra stdout"
  fi
  [ -f "$final/Contents/marker" ] || fail "$label: app was not moved to FINAL"
  marker=$(cat "$final/Contents/marker")
  if [ "$marker" != "fresh" ]; then
    fail "$label: moved app marker is [$marker]"
  fi
  left=$(find "$ROOT/src-tauri/target" -name 'you-brain.app' -type d 2>/dev/null || true)
  if [ -n "$left" ]; then
    fail "$label: app left under target: $left"
  fi
}

assert_no_fallback_warning() {
  if grep -F "已回退为仅 .app" "$ERR" >/dev/null; then
    fail "$1: fallback warning was printed"
  fi
}

assert_no_resign() {
  if grep -F -- "--force" "$CODESIGN_LOG" >/dev/null; then
    fail "$1: codesign --force ran"
  fi
  if grep -F "整包 ad-hoc 重签" "$ERR" >/dev/null; then
    fail "$1: re-sign warning was printed"
  fi
}

assert_verified_once() {
  app_at_sign="$ROOT/src-tauri/target/$1/release/bundle/macos/you-brain.app"
  if ! grep -F -x -- "--verify --deep --strict $app_at_sign" "$CODESIGN_LOG" >/dev/null; then
    fail "$2: missing codesign --verify for $app_at_sign"
  fi
}

assert_empty_stdout() {
  if [ -s "$OUT" ]; then
    fail "$1: expected empty stdout"
  fi
}

pass() {
  passed=$((passed + 1))
  echo "ok: $1"
}

# 1. tauri build succeeds.
setup
export BUNX_MODE=success
run_bundle
[ "$rc" -eq 0 ] || fail "success: exit $rc"
assert_final_lines "success"
assert_no_rw "success"
assert_volumes "success"
assert_kept_noise "success"
assert_no_fallback_warning "success"
[ -f "$REPO/dist/app.noindex/you-brain_0.1.0_aarch64.dmg" ] || fail "success: product dmg was not moved"
if ! grep -F -- "--config src-tauri/tauri.bundle.conf.json" "$REPORT/args" >/dev/null; then
  fail "success: missing bundle config"
fi
if ! grep -F -- "--target aarch64-apple-darwin" "$REPORT/args" >/dev/null; then
  fail "success: default target was not injected"
fi
assert_verified_once aarch64-apple-darwin "success"
assert_no_resign "success"
if grep -F -- " -srcfolder " "$HDIUTIL_LOG" >/dev/null; then
  fail "success: hdiutil create ran without a re-sign"
fi
pass "success"

# 2. DMG step fails after a new .app exists.
setup
export BUNX_MODE=dmg-fail
run_bundle
[ "$rc" -eq 0 ] || fail "dmg-fail: exit $rc"
assert_final_lines "dmg-fail"
assert_no_rw "dmg-fail"
assert_volumes "dmg-fail"
assert_kept_noise "dmg-fail"
if ! grep -F -x "you-brain: DMG 打包失败，已回退为仅 .app" "$ERR" >/dev/null; then
  fail "dmg-fail: missing fallback warning"
fi
assert_verified_once aarch64-apple-darwin "dmg-fail"
assert_no_resign "dmg-fail"
pass "dmg fallback"

# 3. Build fails and no .app was produced.
setup
export BUNX_MODE=fail
run_bundle
[ "$rc" -ne 0 ] || fail "fail: expected non-zero exit"
assert_empty_stdout "fail"
assert_no_rw "fail"
assert_volumes "fail"
assert_kept_noise "fail"
assert_no_fallback_warning "fail"
if ! grep -F -x "you-brain: tauri build did not produce you-brain.app" "$ERR" >/dev/null; then
  fail "fail: missing missing-app error"
fi
[ ! -d "$REPO/dist/app.noindex/you-brain.app" ] || fail "fail: dest app exists"
if [ -s "$CODESIGN_LOG" ]; then
  fail "fail: codesign ran without an app"
fi
pass "hard failure"

# 4. Only a pre-existing .app. remove_stale_apps deletes it; an older mtime
#    recreated by the build must not be treated as this run's bundle.
setup
export BUNX_MODE=stale
old_triple="$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/you-brain.app"
old_host="$ROOT/src-tauri/target/release/bundle/macos/you-brain.app"
old_other="$ROOT/src-tauri/target/custom/release/bundle/macos/you-brain.app"
old_dist="$REPO/dist/nested/you-brain.app"
for old in "$old_triple" "$old_host" "$old_other" "$old_dist"; do
  mkdir -p "$old/Contents"
  echo preexisting > "$old/Contents/marker"
  touch -t 202001010000 "$old/Contents/marker" "$old/Contents" "$old"
done
run_bundle
[ "$rc" -ne 0 ] || fail "stale: expected non-zero exit"
assert_empty_stdout "stale"
assert_no_fallback_warning "stale"
assert_no_rw "stale"
assert_volumes "stale"
if ! grep -F -x "absent" "$REPORT/saw-app" >/dev/null; then
  fail "stale: remove_stale_apps left the triple .app in place for bunx"
fi
marker=$(cat "$old_triple/Contents/marker")
if [ "$marker" != "rebuilt-old" ]; then
  fail "stale: expected rebuilt old marker, got [$marker]"
fi
[ ! -d "$old_host" ] || fail "stale: host .app was not removed"
[ ! -d "$old_other" ] || fail "stale: nested .app was not removed"
[ ! -d "$old_dist" ] || fail "stale: dist .app was not removed"
[ ! -d "$REPO/dist/app.noindex/you-brain.app" ] || fail "stale: old app was published"
if [ -s "$CODESIGN_LOG" ]; then
  fail "stale: codesign ran for an unpublished app"
fi
pass "stale app"

# 5. --bundles app: a failed build is not a DMG fallback, even with a new .app.
setup
export BUNX_MODE=fresh-fail
run_bundle --bundles app
[ "$rc" -ne 0 ] || fail "bundles app: expected non-zero exit"
assert_empty_stdout "bundles app"
assert_no_fallback_warning "bundles app"
assert_no_rw "bundles app"
assert_volumes "bundles app"
[ ! -d "$REPO/dist/app.noindex/you-brain.app" ] || fail "bundles app: app was published"
fresh_left="$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/you-brain.app/Contents/marker"
[ -f "$fresh_left" ] || fail "bundles app: fresh app was removed"
if ! grep -F -- "--bundles app" "$REPORT/args" >/dev/null; then
  fail "bundles app: flag was not forwarded"
fi
if [ -s "$CODESIGN_LOG" ]; then
  fail "bundles app: codesign ran for an unpublished app"
fi
pass "--bundles app"

# 6. --bundles=app still publishes when the build itself succeeds.
setup
export BUNX_MODE=success
run_bundle --bundles=app
[ "$rc" -eq 0 ] || fail "bundles=app: exit $rc"
assert_final_lines "bundles=app"
assert_no_rw "bundles=app"
assert_no_fallback_warning "bundles=app"
if ! grep -F -- "--bundles=app" "$REPORT/args" >/dev/null; then
  fail "bundles=app: flag was not forwarded"
fi
assert_verified_once aarch64-apple-darwin "bundles=app"
assert_no_resign "bundles=app"
pass "--bundles=app success"

# 7. An explicit --target is kept and not replaced by the default triple.
setup
export BUNX_MODE=success
run_bundle --target x86_64-apple-darwin
[ "$rc" -eq 0 ] || fail "custom target: exit $rc"
assert_final_lines "custom target"
if ! grep -F -- "--target x86_64-apple-darwin" "$REPORT/args" >/dev/null; then
  fail "custom target: user target was dropped"
fi
if grep -F -- "--target aarch64-apple-darwin" "$REPORT/args" >/dev/null; then
  fail "custom target: default target was also injected"
fi
assert_verified_once x86_64-apple-darwin "custom target"
assert_no_resign "custom target"
pass "explicit --target"

# 8. The macOS bundle config asks Tauri for an ad-hoc signature.
CONF=$(CDPATH= cd -- "$HERE/../.." && pwd)/src-tauri/tauri.bundle.conf.json
if ! grep -F -- '"signingIdentity": "-"' "$CONF" >/dev/null; then
  fail "config: signingIdentity is not ad-hoc \"-\""
fi
if ! grep -F -- '"hardenedRuntime": false' "$CONF" >/dev/null; then
  fail "config: hardenedRuntime is not false"
fi
pass "signingIdentity config"

# 9. A failed deep verify re-signs in place and does not publish the old DMG.
setup
export BUNX_MODE=success
export CODESIGN_MODE=verify-fail
run_bundle
[ "$rc" -eq 0 ] || fail "re-sign: exit $rc"
assert_final_lines "re-sign"
assert_no_rw "re-sign"
assert_volumes "re-sign"
assert_kept_noise "re-sign"
assert_no_fallback_warning "re-sign"
signed="$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/you-brain.app"
if ! grep -F -x -- "--force --deep --sign - $signed" "$CODESIGN_LOG" >/dev/null; then
  fail "re-sign: missing codesign --force --deep --sign -"
fi
verify_count=$(grep -F -c -x -- "--verify --deep --strict $signed" "$CODESIGN_LOG" || true)
if [ "$verify_count" -ne 2 ]; then
  fail "re-sign: expected 2 verify calls, got $verify_count"
fi
if ! grep -F -x "you-brain: Tauri 签名未通过 codesign --verify --deep --strict，改为整包 ad-hoc 重签" "$ERR" >/dev/null; then
  fail "re-sign: missing re-sign warning"
fi
if ! grep -F -- "-srcfolder $signed" "$HDIUTIL_LOG" >/dev/null; then
  fail "re-sign: hdiutil create did not use the signed app"
fi
if ! grep -F -- "-format UDZO" "$HDIUTIL_LOG" >/dev/null; then
  fail "re-sign: hdiutil create did not request UDZO"
fi
if ! grep -F -x "you-brain: 重签后的 DMG 生成失败，已丢弃旧 DMG" "$ERR" >/dev/null; then
  fail "re-sign: missing dmg refresh failure warning"
fi
[ ! -f "$REPO/dist/app.noindex/you-brain_0.1.0_aarch64.dmg" ] || fail "re-sign: stale product dmg was published"
[ ! -f "$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/you-brain_0.1.0_aarch64.dmg" ] || fail "re-sign: stale product dmg left in the bundle dir"
pass "re-sign drops stale dmg"

# 10. DMG fallback still re-signs, and does not invent a disk image.
setup
export BUNX_MODE=dmg-fail
export CODESIGN_MODE=verify-fail
run_bundle
[ "$rc" -eq 0 ] || fail "dmg-fail re-sign: exit $rc"
assert_final_lines "dmg-fail re-sign"
assert_no_rw "dmg-fail re-sign"
signed="$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/you-brain.app"
if ! grep -F -x -- "--force --deep --sign - $signed" "$CODESIGN_LOG" >/dev/null; then
  fail "dmg-fail re-sign: missing codesign --force"
fi
if grep -F -- " -srcfolder " "$HDIUTIL_LOG" >/dev/null; then
  fail "dmg-fail re-sign: hdiutil create ran without a product dmg"
fi
if ! grep -F -x "you-brain: DMG 打包失败，已回退为仅 .app" "$ERR" >/dev/null; then
  fail "dmg-fail re-sign: missing fallback warning"
fi
pass "dmg fallback re-sign"

# 11. A re-sign that still fails verify does not publish the .app.
setup
export BUNX_MODE=success
export CODESIGN_MODE=verify-always-fail
run_bundle
[ "$rc" -ne 0 ] || fail "verify still failing: expected non-zero exit"
assert_empty_stdout "verify still failing"
assert_no_rw "verify still failing"
[ ! -d "$REPO/dist/app.noindex/you-brain.app" ] || fail "verify still failing: dest app exists"
signed="$ROOT/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/you-brain.app"
if ! grep -F -x -- "--force --deep --sign - $signed" "$CODESIGN_LOG" >/dev/null; then
  fail "verify still failing: missing codesign --force"
fi
if grep -F -- " -srcfolder " "$HDIUTIL_LOG" >/dev/null; then
  fail "verify still failing: dmg was refreshed before verify passed"
fi
pass "re-sign verify failure"

echo "bundle.test.sh: $passed passed, 0 failed"
