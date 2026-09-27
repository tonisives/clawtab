#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LISTENER="$SCRIPT_DIR/../scripts/agent-status-listener.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

sed -n '/^record_snapshot_failure() {/,/^}/p; /^record_snapshot_success() {/,/^}/p' \
    "$LISTENER" >"$TEST_DIR/liveness.sh"
source "$TEST_DIR/liveness.sh"

tmux() {
    printf '%s\n' "$*" >>"$TEST_DIR/tmux-calls"
}
clear_activity_options() {
    printf 'clear\n' >>"$TEST_DIR/clears"
}

activity_was_cleared=0
record_snapshot_failure
[ "$activity_was_cleared" -eq 1 ]
[ "$(wc -l <"$TEST_DIR/clears" | tr -d ' ')" -eq 1 ]
grep -Fxq 'set-option -gq @clawtab-daemon-running 0' "$TEST_DIR/tmux-calls"

record_snapshot_failure
[ "$(wc -l <"$TEST_DIR/clears" | tr -d ' ')" -eq 1 ]

record_snapshot_success
[ "$activity_was_cleared" -eq 0 ]
grep -Fxq 'set-option -gq @clawtab-daemon-running 1' "$TEST_DIR/tmux-calls"

printf 'agent-status liveness tests passed\n'
