#!/usr/bin/env bash
# Wrapper for the `daemon:` Procfile entry under `make dev`.
#
# The daemon (clawtab-daemon, wrapped in ClawTab Daemon.app) is started by
# launchd via dev-daemon-reload.sh after each build. launchd's KeepAlive keeps
# it alive independently of overmind, so a bare `cargo watch` here would leak
# the engine when you C-c `make dev`. This wrapper mirrors dev-desktop-watch.sh:
# it owns cargo watch and, on shutdown, unloads the launchd job so the engine
# stops with the rest of the dev stack.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.clawtab.daemon.plist"

# Keep the launched .app bundle on the internal disk. Cargo can still build
# into an external target dir, but launching a dev .app from that volume can
# trigger macOS removable-volume prompts on login.
export CLAWTAB_ENGINE_APP="${CLAWTAB_ENGINE_APP:-$HOME/Library/Caches/ClawTab-dev/ClawTab Daemon.app}"

did_cleanup=0
cleanup() {
  if [ "$did_cleanup" -eq 1 ]; then
    return
  fi
  did_cleanup=1

  # Stop the launchd-owned engine so it doesn't outlive `make dev`.
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  pkill -f "ClawTab Daemon.app/Contents/MacOS/ClawTab Daemon" >/dev/null 2>&1 || true

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

# launchd may start this before the login session is fully settled. In that
# case cargo-watch can finish after the initial command even though overmind
# should stay up. Keep this wrapper alive until launchd or overmind stops it.
while kill -0 "$cargo_watch_pid" 2>/dev/null; do
  wait "$cargo_watch_pid" || true
  if ! kill -0 "$cargo_watch_pid" 2>/dev/null; then
    while true; do
      sleep 3600
    done
  fi
  sleep 1
done
