#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
sed -n '/^apply_snapshot() {/,/^}/p' "$SCRIPT_DIR/../scripts/agent-status-listener.sh" >"$TEST_DIR/snapshot.sh"
source "$TEST_DIR/snapshot.sh"
JQ_BIN="$(command -v jq)"
ACTIVITY_TSV="$TEST_DIR/activity"
PANE_STATE_FILE="$TEST_DIR/panes"
OPTION_CHANGES_FILE="$TEST_DIR/changes"
PANE_BORDER_CACHE_SCRIPT="/nonexistent"
ADVANCE_QUESTION_PANE_SCRIPT="/nonexistent"
clear_agent_pane_title() { :; }
tmux() {
    if [ "$1" = list-panes ]; then
        printf '%s\n' "$test_panes"
    else
        printf '%s\n' "$*" >>"$TEST_DIR/calls"
    fi
}

# An alert requests pane attention while staying separate from answerable questions.
test_panes=$'%1|||@1|||0|||0|||0|||0|||0|||1|||0|||0\n%2|||@1|||0|||0|||0|||0|||0|||0|||0|||0'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false,"alert":"Selected model is at capacity."},{"pane_id":"%2","working":true,"asking":false}]}'
grep -Fxq $'pane\t%1\t1\t0\t1\t1' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t1\t1\t0\t1' "$OPTION_CHANGES_FILE"
grep -q '@clawtab-agent-pane-alert 1' "$TEST_DIR/calls"
grep -q '@clawtab-agent-alert 1' "$TEST_DIR/calls"

# Clearing an alert advances attention within the correct window, even when
# the last listed pane belongs to another window.
test_panes=$'%1|||@1|||1|||1|||0|||0|||1|||1|||1|||1\n%2|||@1|||1|||1|||0|||0|||1|||0|||1|||1\n%3|||@2|||0|||0|||0|||0|||0|||1|||0|||0'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false},{"pane_id":"%2","working":false,"asking":false,"alert":"Quota exceeded"}]}'
grep -Fxq $'pane\t%1\t1\t0\t0\t0' "$OPTION_CHANGES_FILE"
grep -Fxq $'advance\t@1\t%1' "$OPTION_CHANGES_FILE"

# Snapshots from older daemons clear the alert without changing question state.
test_panes=$'%1|||@1|||1|||1|||0|||0|||1|||1|||1|||1'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":true}]}'
grep -Fxq $'pane\t%1\t1\t0\t1\t0' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t1\t0\t1\t0' "$OPTION_CHANGES_FILE"
apply_snapshot '{"AgentActivity":[]}'
grep -Fxq $'pane\t%1\t0\t0\t0\t0' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t0\t0\t0\t0' "$OPTION_CHANGES_FILE"
printf 'agent alert tests passed\n'
