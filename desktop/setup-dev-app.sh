#!/bin/bash
# Wraps the dev binary in a .app bundle so macOS treats it as a real GUI
# application (Dock icon, key window status, keyboard input). Without this,
# the bare `cargo` binary runs as a background tool and cannot accept text input.
set -e

TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
BIN="$TARGET_DIR/debug/clawtab"
APP="$TARGET_DIR/debug/ClawTab.app"
VERSION=$(node -p "require('$(dirname "$0")/package.json').version")

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>ClawTab</string>
    <key>CFBundleDisplayName</key><string>ClawTab</string>
    <key>CFBundleIdentifier</key><string>cc.clawtab</string>
    <key>CFBundleExecutable</key><string>clawtab</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}-dev</string>
    <key>CFBundleVersion</key><string>${VERSION}-dev</string>
    <key>LSMinimumSystemVersion</key><string>10.15</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
ln -sf "$BIN" "$APP/Contents/MacOS/clawtab"
echo "ClawTab.app ready at $APP"
