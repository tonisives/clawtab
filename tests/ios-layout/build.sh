#!/bin/sh
set -eu
: "${BUILD_SERVICE_XCODE_DEVELOPER_DIR:?Run on the shared build worker}"
export DEVELOPER_DIR="$BUILD_SERVICE_XCODE_DEVELOPER_DIR"
cd "$(dirname "$0")/../../remote"
node --test scripts/test-landscape-insets.cjs
pnpm exec tsc --noEmit
node <<'JS'
const fs = require("node:fs");
const { expo } = JSON.parse(fs.readFileSync("app.json", "utf8"));
expo.name = "ClawTabLayout";
expo.slug = "clawtab-layout";
expo.scheme = "clawtab-layout";
expo.plugins = expo.plugins.filter(entry => Array.isArray(entry) && entry[0] === "@react-native-google-signin/google-signin");
expo.updates = { enabled: false };
expo.ios = { bundleIdentifier: "cc.clawtab.layout-runtime", supportsTablet: true };
fs.writeFileSync("app.json", JSON.stringify({ expo }));
// Enter the real workspace anonymously, using sample data without an account.
fs.writeFileSync("app/index.tsx", 'import { Redirect } from "expo-router"; export default function Index() { return <Redirect href="/(tabs)" />; }\n');
// The isolated anonymous test app must also be able to open sample detail routes.
const layout = fs.readFileSync("app/_layout.tsx", "utf8");
fs.writeFileSync("app/_layout.tsx", layout.replace('guard={Platform.OS !== "ios" || isAuthenticated}', 'guard={true}'));
JS
if [ "${1:-}" = "--bundle-only" ]; then
  mkdir -p ../tests/ios-layout/bundle
  pnpm expo export:embed --platform ios --dev false --entry-file index.ts \
    --bundle-output ../tests/ios-layout/bundle/main.jsbundle \
    --assets-dest ../tests/ios-layout/bundle
else
pnpm expo prebuild --platform ios --no-install
cd ios
sed -i '' '1i\
use_modular_headers!\
' Podfile
pod install
cd ..
ENTRY_FILE=index.ts xcodebuild -quiet -workspace ios/ClawTabLayout.xcworkspace \
  -scheme ClawTabLayout -configuration Release -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ../tests/ios-layout/build -jobs 4 ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build
fi
cd ../tests/ios-layout
xcodebuild -quiet -project LayoutTests.xcodeproj -scheme LayoutTests \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath runner-build -jobs 4 \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES build-for-testing
