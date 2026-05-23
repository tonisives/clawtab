#!/usr/bin/env bash
# Post-build hook for the `daemon:` Procfile entry under `make dev`.
#
# After cargo-watch produces a fresh debug build of clawtab-daemon, refresh
# the Clawtab Engine.app bundle (so notifications keep working via
# UNUserNotificationCenter) and reload the LaunchAgent so launchd picks up
# the new binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CARGO_TARGET_DIR_RESOLVED="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
DAEMON_BIN="$CARGO_TARGET_DIR_RESOLVED/debug/clawtab-daemon"
# Engine .app lives next to other dev build artifacts under the cargo target
# dir, so no root-owned paths (/usr/local) are involved.
ENGINE_APP="$CARGO_TARGET_DIR_RESOLVED/debug/Clawtab Engine.app"

if [[ ! -f "$DAEMON_BIN" ]]; then
  echo "[dev-daemon] no debug binary at $DAEMON_BIN; skipping reload" >&2
  exit 0
fi

bash "$SCRIPT_DIR/build-engine-app.sh" "$DAEMON_BIN" "$ENGINE_APP"

launchctl unload ~/Library/LaunchAgents/com.clawtab.daemon.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.clawtab.daemon.plist
