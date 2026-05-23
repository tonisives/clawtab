#!/usr/bin/env bash
# Assembles "Clawtab Engine.app" from the engine-app template and the
# clawtab-daemon binary. Used by:
#   - `make build-daemon` for local dev installs
#   - the Tauri build hook so the .app gets nested inside ClawTab.app
#
# Usage: build-engine-app.sh <daemon-binary-path> <output-app-path>

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <daemon-binary> <output-app-path>" >&2
  exit 1
fi

DAEMON_BIN="$1"
APP_PATH="$2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../engine-app"

if [[ ! -f "$DAEMON_BIN" ]]; then
  echo "daemon binary not found: $DAEMON_BIN" >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE_DIR/Info.plist" ]]; then
  echo "engine-app template not found: $TEMPLATE_DIR/Info.plist" >&2
  exit 1
fi

rm -rf "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS"
mkdir -p "$APP_PATH/Contents/Resources"

cp "$TEMPLATE_DIR/Info.plist" "$APP_PATH/Contents/Info.plist"
cp "$DAEMON_BIN" "$APP_PATH/Contents/MacOS/clawtab-daemon"
chmod +x "$APP_PATH/Contents/MacOS/clawtab-daemon"

# Ad-hoc sign the bundle so macOS treats it as a real .app and grants it a
# stable code-identity for NotificationCenter and TCC. Without this, the
# system treats every rebuild as a new app and re-prompts for permissions.
codesign --force --sign - "$APP_PATH" >/dev/null 2>&1 || true

# Register the bundle with LaunchServices so its bundle id becomes known
# system wide. Without this, UNUserNotificationCenter rejects authorization
# requests with "Notifications are not allowed for this application" and
# the app never appears in System Settings -> Notifications.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$APP_PATH" >/dev/null 2>&1 || true
fi

echo "Built $APP_PATH"
