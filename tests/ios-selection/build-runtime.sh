#!/bin/sh
set -eu
: "${BUILD_SERVICE_XCODE_DEVELOPER_DIR:?Run this script on the shared build worker}"
export DEVELOPER_DIR="$BUILD_SERVICE_XCODE_DEVELOPER_DIR"
cd "$(dirname "$0")/../../remote"
node <<'JS'
const fs = require('node:fs');
const { expo } = JSON.parse(fs.readFileSync('app.json', 'utf8'));
expo.name = 'ClawTabSelection';
expo.slug = 'clawtab-selection';
expo.scheme = 'clawtab-selection';
expo.plugins = [];
expo.updates = { enabled: false };
expo.ios = { bundleIdentifier: 'cc.clawtab.selection-runtime', supportsTablet: false };
fs.writeFileSync('app.json', JSON.stringify({ expo }));
fs.writeFileSync('index.ts', 'import { registerRootComponent } from "expo";\nimport App from "./tests/selection-runtime";\nregisterRootComponent(App);\n');
JS
pnpm expo prebuild --platform ios --no-install
cd ios
sed -i '' '1i\
use_modular_headers!\
' Podfile
pod install
cd ..
ENTRY_FILE=index.ts xcodebuild -quiet -workspace ios/ClawTabSelection.xcworkspace \
  -scheme ClawTabSelection -configuration Release -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ../tests/ios-selection/runtime-build -jobs 4 ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build
