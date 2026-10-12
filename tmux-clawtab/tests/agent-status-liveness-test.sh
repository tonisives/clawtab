#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LISTENER="$SCRIPT_DIR/../scripts/agent-status-listener.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

sed -n '/^cleanup() {/,/^}/p; /^tmux_server_is_alive() {/,/^}/p; /^record_snapshot_failure() {/,/^}/p; /^record_snapshot_success() {/,/^}/p' \
    "$LISTENER" >"$TEST_DIR/liveness.sh"
source "$TEST_DIR/liveness.sh"

tmux() {
    if [ "${1:-}" = "-S" ]; then
        printf '%s\n' "$test_server_identity"
        return
    fi
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

# A listener from the previous server generation still owns its lock, but
# must not clear the healthy replacement server's daemon flag on exit.
event_nc_pid=""
tmux_server_socket="$TEST_DIR/tmux.sock"
tmux_server_identity="${tmux_server_socket}:100"
test_server_identity="${tmux_server_socket}:200"
prepare_lock() {
    LOCK_DIR="$TEST_DIR/listener.lock"
    mkdir "$LOCK_DIR"
    printf '%s\n' "$$" >"$LOCK_DIR/pid"
    EVENT_PIPE="$LOCK_DIR/events"
    ACTIVITY_TSV="$LOCK_DIR/activity.tsv"
    PANE_STATE_FILE="$LOCK_DIR/pane-state"
    OPTION_CHANGES_FILE="$LOCK_DIR/option-changes.tsv"
    touch "$EVENT_PIPE" "$ACTIVITY_TSV" "$PANE_STATE_FILE" "$OPTION_CHANGES_FILE"
}
prepare_lock
: >"$TEST_DIR/tmux-calls"
cleanup
[ ! -d "$LOCK_DIR" ]
[ ! -s "$TEST_DIR/tmux-calls" ]

# A listener exiting while its own server is alive still hides indicators.
test_server_identity="$tmux_server_identity"
prepare_lock
cleanup
[ ! -d "$LOCK_DIR" ]
grep -Fxq 'set-option -gq @clawtab-daemon-running 0' "$TEST_DIR/tmux-calls"

printf 'agent-status liveness tests passed\n'
