#!/usr/bin/env bash
# Wrapper for the `daemon:` Procfile entry under `make dev`.
#
# The engine (clawtab-daemon, wrapped in Clawtab Engine.app) is started by
# launchd via dev-daemon-reload.sh after each build. launchd's KeepAlive keeps
# it alive independently of overmind, so a bare `cargo watch` here would leak
# the engine when you C-c `make dev`. This wrapper mirrors dev-desktop-watch.sh:
# it owns cargo watch and, on shutdown, unloads the launchd job so the engine
# stops with the rest of the dev stack.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.clawtab.daemon.plist"

# In dev the launchd plist launches the engine app from the cargo target dir,
# not /usr/local (which needs root). Point the reload hook at the same path so
# the app launchd runs is the one we actually rebuild.
TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
export CLAWTAB_ENGINE_APP="$TARGET_DIR/debug/Clawtab Engine.app"

did_cleanup=0
cleanup() {
  if [ "$did_cleanup" -eq 1 ]; then
    return
  fi
  did_cleanup=1

  # Stop the launchd-owned engine so it doesn't outlive `make dev`.
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  pkill -f "Clawtab Engine.app/Contents/MacOS/ClawTab Daemon" >/dev/null 2>&1 || true

  if [ -n "${cargo_watch_pid:-}" ]; then
    kill -TERM "$cargo_watch_pid" >/dev/null 2>&1 || true
  fi
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

cd "$SRC_TAURI_DIR"
cargo watch \
  -x "build --bin clawtab-daemon --no-default-features" \
  -s "bash $SCRIPT_DIR/dev-daemon-reload.sh" &
cargo_watch_pid=$!

# Wait in a loop so the INT/TERM trap runs promptly instead of being deferred
# until a single blocking `wait` returns.
while kill -0 "$cargo_watch_pid" 2>/dev/null; do
  wait "$cargo_watch_pid"
done
