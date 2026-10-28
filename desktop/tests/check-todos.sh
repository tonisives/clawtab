#!/usr/bin/env bash
set -euo pipefail
if [[ "${BUILD_SERVICE_WORKER:-}" != 1 ]]; then
  echo 'Run with buildctl run --cwd desktop --prepare-node -- bash tests/check-todos.sh' >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
mkdir -p dist/todo-checks
node --test tests/mobile-message-ui.test.cjs
node desktop/tests/nfn-fixture.mjs dist/todo-checks/renderer.html
clang -fobjc-arc -fblocks desktop/tests/nfn-webkit.m -framework AppKit -framework WebKit -o dist/todo-checks/renderer-check
dist/todo-checks/renderer-check dist/todo-checks/renderer.html desktop/tests/todo-browser-check.js dist/todo-checks/tasks.png
