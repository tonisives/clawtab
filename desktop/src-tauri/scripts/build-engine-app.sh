#!/usr/bin/env bash
# Assembles "ClawTab Daemon.app" from the engine-app template and the
# clawtab-daemon binary (placed inside the bundle as "ClawTab Daemon"). Used by
# the Tauri build hook so the .app gets nested inside ClawTab.app.
#
# Usage: build-engine-app.sh <daemon-binary-path> <hook-binary-path> <output-app-path>

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <daemon-binary> <hook-binary> <output-app-path>" >&2
  exit 1
fi

DAEMON_BIN="$1"
HOOK_BIN="$2"
APP_PATH="$3"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../engine-app"

if [[ ! -f "$DAEMON_BIN" ]]; then
  echo "daemon binary not found: $DAEMON_BIN" >&2
  exit 1
fi
if [[ ! -f "$HOOK_BIN" ]]; then
  echo "hook binary not found: $HOOK_BIN" >&2
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
# The in-bundle executable is named "ClawTab Daemon" (not the bare cargo bin
# name) so Activity Monitor / launchd show that as the process name, the same
# way Keyboard Maestro ships "Keyboard Maestro Engine". CFBundleExecutable in
# the template Info.plist must match this filename.
cp "$DAEMON_BIN" "$APP_PATH/Contents/MacOS/ClawTab Daemon"
chmod +x "$APP_PATH/Contents/MacOS/ClawTab Daemon"
cp "$HOOK_BIN" "$APP_PATH/Contents/MacOS/clawtab-hook"
chmod +x "$APP_PATH/Contents/MacOS/clawtab-hook"

# Bundle the app icon so Activity Monitor and System Settings show it. The
# icon lives next to the desktop app's icons; CFBundleIconFile in the template
# Info.plist points at this filename.
ICON_SRC="$SCRIPT_DIR/../icons/icon.icns"
if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$APP_PATH/Contents/Resources/icon.icns"
fi

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
