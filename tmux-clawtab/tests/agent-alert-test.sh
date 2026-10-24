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
grep -Fxq $'pane\t%1\t1\t0\t1\t1\t0' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t1\t1\t0\t1\t0' "$OPTION_CHANGES_FILE"
grep -q '@clawtab-agent-pane-alert 1' "$TEST_DIR/calls"
grep -q '@clawtab-agent-alert 1' "$TEST_DIR/calls"

# Clearing an alert advances attention within the correct window, even when
# the last listed pane belongs to another window.
test_panes=$'%1|||@1|||1|||1|||0|||0|||1|||1|||1|||1\n%2|||@1|||1|||1|||0|||0|||1|||0|||1|||1\n%3|||@2|||0|||0|||0|||0|||0|||1|||0|||0'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false},{"pane_id":"%2","working":false,"asking":false,"alert":"Quota exceeded"}]}'
grep -Fxq $'pane\t%1\t1\t0\t0\t0\t0' "$OPTION_CHANGES_FILE"
grep -Fxq $'advance\t@1\t%1' "$OPTION_CHANGES_FILE"

# Snapshots from older daemons clear the alert without changing question state.
test_panes=$'%1|||@1|||1|||1|||0|||0|||1|||1|||1|||1'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":true}]}'
grep -Fxq $'pane\t%1\t1\t0\t1\t0\t0' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t1\t0\t1\t0\t0' "$OPTION_CHANGES_FILE"
apply_snapshot '{"AgentActivity":[]}'
grep -Fxq $'pane\t%1\t0\t0\t0\t0\t0' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t0\t0\t0\t0\t0' "$OPTION_CHANGES_FILE"
# Size warnings expose their current MB in pane and window status. A window
# uses the largest warning, including when a provider error precedes it.
test_panes=$'%1|||@1|||1|||1|||0|||0|||1|||1|||1|||1|||0|||0\n%2|||@1|||1|||1|||0|||0|||1|||0|||1|||1|||0|||0'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false,"alert":"Codex session file is 590 MB (warning at 200 MB)."},{"pane_id":"%2","working":false,"asking":false,"alert":"Selected model is at capacity.\nCodex session file is 1200 MB (warning at 200 MB)."}]}'
grep -Fxq $'pane\t%1\t1\t0\t1\t1\t590' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t1\t0\t0\t1\t1200' "$OPTION_CHANGES_FILE"
grep -q '@clawtab-agent-pane-size-mb 590' "$TEST_DIR/calls"
grep -q '@clawtab-agent-size-mb 1200' "$TEST_DIR/calls"

# A size change updates status even while the alert remains active.
test_panes=$'%1|||@1|||1|||1|||0|||0|||1|||1|||1|||1|||590|||590'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false,"alert":"Codex session file is 591 MB (warning at 200 MB)."}]}'
grep -Fxq $'pane\t%1\t1\t0\t1\t1\t591' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t1\t0\t0\t1\t591' "$OPTION_CHANGES_FILE"

# Clearing the size warning keeps any remaining provider alert.
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false,"alert":"Selected model is at capacity."}]}'
grep -Fxq $'pane\t%1\t1\t0\t1\t1\t0' "$OPTION_CHANGES_FILE"
grep -Fxq $'window\t@1\t1\t0\t0\t1\t0' "$OPTION_CHANGES_FILE"
# The newest actual agent action wins across panes, independently of flags.
test_panes=$'%1|||@1|||1|||1|||0|||0|||0|||1|||0|||0|||0|||0|||0\n%2|||@1|||1|||1|||0|||0|||0|||0|||0|||0|||0|||0|||0'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false,"last_action_at_ms":1700000000123},{"pane_id":"%2","working":false,"asking":false,"last_action_at_ms":1700000060999}]}'
grep -Fxq $'action\t@1\t1700000060' "$OPTION_CHANGES_FILE"
grep -q '@clawtab-agent-last-action-at 1700000060' "$TEST_DIR/calls"

# Snapshot refresh and focus have no effect when the action time is unchanged.
test_panes=$'%1|||@1|||1|||1|||0|||0|||0|||1|||0|||0|||0|||0|||1700000060'
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false,"last_action_at_ms":1700000060999}]}'
if grep -q '^action' "$OPTION_CHANGES_FILE"; then exit 1; fi
apply_snapshot '{"AgentActivity":[{"pane_id":"%1","working":false,"asking":false,"last_action_at_ms":1700000120000}]}'
grep -Fxq $'action\t@1\t1700000120' "$OPTION_CHANGES_FILE"

# A removed agent or old daemon clears the unavailable action time.
apply_snapshot '{"AgentActivity":[]}'
grep -Fxq $'action\t@1\t0' "$OPTION_CHANGES_FILE"
grep -q 'set-window-option -qu -t @1 @clawtab-agent-last-action-at' "$TEST_DIR/calls"
printf 'agent alert tests passed\n'
