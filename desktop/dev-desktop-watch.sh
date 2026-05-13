#!/bin/bash
set -euo pipefail

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cd "$SCRIPT_DIR"
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
