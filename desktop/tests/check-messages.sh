#!/usr/bin/env bash
set -euo pipefail

if [[ "${BUILD_SERVICE_WORKER:-}" != 1 ]]; then
  echo 'Run this check with buildctl run --cwd desktop --prepare-node -- bash tests/check-messages.sh' >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
results="$root/dist/message-checks"
temporary="$(mktemp -d)"
mkdir -p "$results"
node desktop/tests/nfn-fixture.mjs "$temporary/renderer.html"
node desktop/tests/nfn-fixture.mjs "$temporary/native.html" --native
clang -fobjc-arc -fblocks desktop/tests/nfn-webkit.m -framework AppKit -framework WebKit -o "$temporary/renderer-check"
clang -fobjc-arc -fblocks desktop/tests/nfn-native.m -framework AppKit -framework WebKit -framework Intents -framework UserNotifications -framework ApplicationServices -framework Carbon -o "$temporary/native-check"
"$temporary/renderer-check" "$temporary/renderer.html" "$root/desktop/tests/nfn-browser-check.js" > "$results/renderer.log" 2>&1
"$temporary/native-check" "$temporary/native.html" --right > "$results/native.log" 2>&1
"$temporary/native-check" "$temporary/native.html" --notch-geometry > "$results/notch.log" 2>&1
for image in /tmp/clawtab-nfn-*.png; do
  [[ ! -f "$image" ]] || cp "$image" "$results/"
done
cat "$results/renderer.log" "$results/native.log" "$results/notch.log"
