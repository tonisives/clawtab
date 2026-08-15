#!/usr/bin/env bash

# Select a pane with an active question when entering a window. If there is no
# question, leave tmux's remembered active pane untouched.
set -u

window_id="${1:-}"
[ -n "$window_id" ] || exit 0

target_pane="$({
    tmux list-panes -t "$window_id" \
        -F '#{pane_id}|||#{@clawtab-agent-asking}|||#{pane_active}' \
        2>/dev/null || true
} | awk '
    {
        split($0, field, /\|\|\|/)
    }
    field[2] == "1" && field[3] == "1" {
        active = field[1]
    }
    field[2] == "1" && first == "" {
        first = field[1]
    }
    END {
        if (active != "") print active
        else if (first != "") print first
    }
')"

[ -n "$target_pane" ] || exit 0
tmux select-pane -t "$target_pane" 2>/dev/null || true
