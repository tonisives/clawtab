#!/bin/bash
set -euo pipefail

TARGET_DIR="${CARGO_TARGET_DIR:-/Volumes/sam/build/rust/targets}"
APP="$TARGET_DIR/debug/ClawTab.app"
APP_BIN="$APP/Contents/MacOS/clawtab"
DEBUG_BIN="$TARGET_DIR/debug/clawtab"

pids_for_pattern() {
  local pattern="$1"
  ps -Ao pid=,command= | awk -v pattern="$pattern" '
    {
      pid = $1
      $1 = ""
      sub(/^ +/, "")
      if ($0 == pattern) {
        print pid
      }
    }
  '
}

stop_pattern() {
  local pattern="$1"
  local pids

  pids="$(pids_for_pattern "$pattern")"
  if [ -n "$pids" ]; then
    kill -TERM $pids >/dev/null 2>&1 || true

    for _ in {1..30}; do
      pids="$(pids_for_pattern "$pattern")"
      if [ -z "$pids" ]; then
        return 0
      fi
      sleep 0.1
    done

    pids="$(pids_for_pattern "$pattern")"
    if [ -n "$pids" ]; then
      kill -KILL $pids >/dev/null 2>&1 || true
    fi
  fi
}

stop_pattern "$APP_BIN"
stop_pattern "$DEBUG_BIN"
