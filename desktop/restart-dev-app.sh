#!/bin/bash
set -euo pipefail

TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
BIN="$TARGET_DIR/debug/clawtab"
APP="${CLAWTAB_DEV_APP:-$HOME/Library/Caches/ClawTab-dev/ClawTab.app}"

"$(dirname "$0")/stop-dev-app.sh"

cp -f "$BIN" "$APP/Contents/MacOS/clawtab"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
fi

open -n "$APP"
