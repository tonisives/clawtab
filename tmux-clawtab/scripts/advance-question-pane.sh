#!/usr/bin/env bash

# Select the first remaining question after an active pane's question was
# answered. Only advance while the answered pane is still selected, so manual
# pane navigation cancels the automatic focus change.
set -u

window_id="${1:-}"
answered_pane="${2:-}"
[ -n "$window_id" ] || exit 0
[ -n "$answered_pane" ] || exit 0

target_pane="$({
    tmux list-panes -t "$window_id" \
        -F '#{pane_id}|||#{pane_active}|||#{@clawtab-agent-asking}' \
        2>/dev/null || true
} | awk -v answered="$answered_pane" '
    {
        split($0, field, /\|\|\|/)
    }
    field[2] == "1" {
        active = field[1]
    }
    field[3] == "1" && field[1] != answered && first == "" {
        first = field[1]
    }
    END {
        if (active == answered && first != "") print first
    }
')"

[ -n "$target_pane" ] || exit 0
tmux select-pane -t "$target_pane" 2>/dev/null || true
