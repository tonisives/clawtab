#!/bin/bash
set -euo pipefail

TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
APP="$TARGET_DIR/debug/ClawTab.app"

"$(dirname "$0")/stop-dev-app.sh"

open -n "$APP"
