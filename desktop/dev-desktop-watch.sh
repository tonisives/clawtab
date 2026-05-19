#!/bin/bash
# IMPORTANT: dev mode must launch the binary through a .app bundle via `open -n`,
# not the bare binary. Without the bundle, macOS LaunchServices does not register
# the cc.clawtab bundle id with the process, so tiling WMs like Aerospace report
# `NULL-APP-BUNDLE-ID` and refuse to manage the window. The flow below
# (setup-dev-app.sh -> cargo watch -> restart-dev-app.sh) keeps that intact.
set -euo pipefail

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$SCRIPT_DIR"

# Guard: if any of the bundle-launch scripts are missing, fail loudly. Letting
# this slide silently leaves cargo watch running but launching the bare binary,
# which breaks Aerospace tiling.
for script in setup-dev-app.sh restart-dev-app.sh stop-dev-app.sh; do
  if [ ! -x "$SCRIPT_DIR/$script" ]; then
    echo "dev-desktop-watch.sh: missing or non-executable $script" >&2
    echo "  Aerospace will not tile the dev window without it. Restore the" >&2
    echo "  script (it lives next to this one in public/desktop/) and retry." >&2
    exit 1
  fi
done

echo "dev-desktop-watch.sh: launching via .app bundle so Aerospace can tile it"
./setup-dev-app.sh

did_cleanup=0
cargo_watch_pid=""
cleanup() {
  if [ "$did_cleanup" -eq 1 ]; then
    return
  fi
  did_cleanup=1
  "$SCRIPT_DIR/stop-dev-app.sh" || true
  if [ -n "$cargo_watch_pid" ]; then
    kill -TERM "$cargo_watch_pid" >/dev/null 2>&1 || true
    wait "$cargo_watch_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

cd src-tauri
cargo watch \
  -x "build --bin clawtab --no-default-features --features desktop" \
  -s "$SCRIPT_DIR/restart-dev-app.sh" &
cargo_watch_pid=$!
wait "$cargo_watch_pid"
