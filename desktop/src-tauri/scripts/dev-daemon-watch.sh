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

if ! command -v cargo-watch >/dev/null 2>&1; then
  echo "[dev-daemon] cargo-watch is not installed or not in PATH" >&2
  echo "[dev-daemon] install it with: cargo install cargo-watch" >&2
  exit 1
fi

did_cleanup=0
cargo_watch_pid=""
cleanup() {
  if [ "$did_cleanup" -eq 1 ]; then
    return
  fi
  did_cleanup=1

  # Stop the launchd-owned engine so it doesn't outlive `make dev`.
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  pkill -f "ClawTab Daemon.app/Contents/MacOS/ClawTab Daemon" >/dev/null 2>&1 || true

  if [ -n "$cargo_watch_pid" ]; then
    kill -TERM "$cargo_watch_pid" >/dev/null 2>&1 || true
    wait "$cargo_watch_pid" >/dev/null 2>&1 || true
  fi
}
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
trap cleanup EXIT

cd "$SRC_TAURI_DIR"
start_cargo_watch() {
  cargo watch \
    -x "build --bin clawtab-daemon --no-default-features" \
    -s "bash $SCRIPT_DIR/dev-daemon-reload.sh" &
  cargo_watch_pid=$!
}

# launchd may start this before the login session is fully settled. If
# cargo-watch exits during startup or later crashes, restart it so the daemon
# continues to pick up source changes without restarting the dev stack.
while true; do
  start_cargo_watch
  wait "$cargo_watch_pid" || exit_code=$?
  exit_code="${exit_code:-0}"
  cargo_watch_pid=""

  if [ "$did_cleanup" -eq 1 ]; then
    exit "$exit_code"
  fi

  echo "[dev-daemon] cargo-watch exited with status $exit_code; restarting" >&2
  unset exit_code
  sleep 1
done
