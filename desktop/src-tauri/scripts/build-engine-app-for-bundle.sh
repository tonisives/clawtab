#!/usr/bin/env bash
# Hook for tauri.conf.json:build.beforeBundleCommand.
#
# Builds the daemon, hook helper, and cwtctl (release, no default features).
# It assembles the daemon app and stages the CLI plus its Zsh completion at
# the locations referenced by bundle.resources in tauri.conf.json.
#
# Invoked from the desktop package root by tauri.conf.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Match the shared target directory used by the Makefile when provided, and
# fall back to the local target directory for standalone Tauri builds.
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${CARGO_TARGET_ROOT:-$SRC_TAURI_DIR/target}}"
export CARGO_TARGET_DIR

cd "$SRC_TAURI_DIR"

echo "[engine-bundle] building daemon, hook helper, and cwtctl (release, no default features)"
cargo build --release --bin clawtab-daemon --bin clawtab-hook --bin cwtctl --no-default-features

# rust-analyzer / shared target dir sometimes puts output under a hashed
# workspace subfolder (e.g. src-tauri-79532e). Pick the freshest copy.
find_release_binary() {
  local name="$1"
  local candidate
  local newest=""
  local -a candidates=(
    "$CARGO_TARGET_DIR/release/$name"
    "$CARGO_TARGET_DIR"/*/release/"$name"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -f "$candidate" ]] && { [[ -z "$newest" ]] || [[ "$candidate" -nt "$newest" ]]; }; then
      newest="$candidate"
    fi
  done

  printf '%s' "$newest"
}

DAEMON_BIN="$(find_release_binary clawtab-daemon)"

if [[ -z "$DAEMON_BIN" ]] || [[ ! -f "$DAEMON_BIN" ]]; then
  echo "[engine-bundle] error: clawtab-daemon binary not found under $CARGO_TARGET_DIR" >&2
  exit 1
fi

HOOK_BIN="$(find_release_binary clawtab-hook)"

if [[ -z "$HOOK_BIN" ]] || [[ ! -f "$HOOK_BIN" ]]; then
  echo "[engine-bundle] error: clawtab-hook binary not found under $CARGO_TARGET_DIR" >&2
  exit 1
fi

CWTCTL_BIN="$(find_release_binary cwtctl)"

if [[ -z "$CWTCTL_BIN" ]] || [[ ! -f "$CWTCTL_BIN" ]]; then
  echo "[engine-bundle] error: cwtctl binary not found under $CARGO_TARGET_DIR" >&2
  exit 1
fi

OUT_DIR="$SRC_TAURI_DIR/../target/engine-bundle"
APP_PATH="$OUT_DIR/ClawTab Daemon.app"

mkdir -p "$OUT_DIR"
bash "$SCRIPT_DIR/build-engine-app.sh" "$DAEMON_BIN" "$HOOK_BIN" "$APP_PATH"
cp "$CWTCTL_BIN" "$OUT_DIR/cwtctl"
cp "$SRC_TAURI_DIR/../completions/_cwtctl" "$OUT_DIR/_cwtctl"
chmod +x "$OUT_DIR/cwtctl"

echo "[engine-bundle] staged at $APP_PATH"
