#!/usr/bin/env bash
# Hook for tauri.conf.json:build.beforeBundleCommand.
#
# Builds clawtab-daemon (release, no default features) and assembles it into
# a ClawTab Daemon.app skeleton at the location referenced by
# bundle.resources in tauri.conf.json. Tauri then copies that into
# ClawTab.app/Contents/Resources/ during bundling.
#
# Runs from the src-tauri/ directory (Tauri's CWD for build hooks).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Match the CARGO_TARGET_DIR used by the Makefile so we hit the same cache.
# Fall back to the local target/ when running outside the Makefile.
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${CARGO_TARGET_ROOT:-$SRC_TAURI_DIR/target}}"
export CARGO_TARGET_DIR

cd "$SRC_TAURI_DIR"

echo "[engine-bundle] building clawtab-daemon (release, no default features)"
cargo build --release --bin clawtab-daemon --no-default-features

# rust-analyzer / shared target dir sometimes puts output under a hashed
# workspace subfolder (e.g. src-tauri-79532e). Pick the freshest copy.
DAEMON_BIN="$(ls -t \
  "$CARGO_TARGET_DIR/release/clawtab-daemon" \
  "$CARGO_TARGET_DIR"/*/release/clawtab-daemon \
  2>/dev/null | head -1)"

if [[ -z "$DAEMON_BIN" ]] || [[ ! -f "$DAEMON_BIN" ]]; then
  echo "[engine-bundle] error: clawtab-daemon binary not found under $CARGO_TARGET_DIR" >&2
  exit 1
fi

OUT_DIR="$SRC_TAURI_DIR/../target/engine-bundle"
APP_PATH="$OUT_DIR/ClawTab Daemon.app"

mkdir -p "$OUT_DIR"
bash "$SCRIPT_DIR/build-engine-app.sh" "$DAEMON_BIN" "$APP_PATH"

echo "[engine-bundle] staged at $APP_PATH"
