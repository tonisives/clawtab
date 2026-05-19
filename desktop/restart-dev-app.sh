#!/bin/bash
set -euo pipefail

TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
BIN="$TARGET_DIR/debug/clawtab"
APP="${CLAWTAB_DEV_APP:-$HOME/Library/Caches/ClawTab-dev/ClawTab.app}"

"$(dirname "$0")/stop-dev-app.sh"

cp -f "$BIN" "$APP/Contents/MacOS/clawtab"

open -n "$APP"
