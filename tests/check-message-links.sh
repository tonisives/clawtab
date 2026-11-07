#!/usr/bin/env bash
set -euo pipefail
if [[ "${BUILD_SERVICE_WORKER:-}" != 1 && "${CI:-}" != true ]]; then
  echo 'Run this check through buildctl run --cwd desktop --prepare-node -- bash ../tests/check-message-links.sh' >&2
  exit 2
fi
cd "$(dirname "$0")/.."
node --test tests/message-links.test.cjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib agent_session::latest_message::tests -j4
out=dist/message-links-checks
mkdir -p "$out"
clang -fobjc-arc -fblocks desktop/tests/nfn-webkit.m -framework AppKit -framework WebKit -o "$out/renderer-check"
node desktop/tests/nfn-fixture.mjs "$out/desktop.html" --headless-visible
node tests/message-immediate-fixture.cjs "$out/mobile.html"
for surface in desktop mobile; do
  NFN_CHECK_WIDTH=390 NFN_CHECK_HEIGHT=844 "$out/renderer-check" "$out/$surface.html" "$PWD/tests/message-links-browser-check.js" "$out/$surface.png"
done
"$out/renderer-check" "$out/desktop.html" "$PWD/desktop/tests/nfn-browser-check.js"
