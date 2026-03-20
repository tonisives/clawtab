#!/usr/bin/env bash
# Toggle auto-yes for the current tmux pane (only if it's a Claude Code pane)

pane_id="$TMUX_PANE"
if [ -z "$pane_id" ]; then
    pane_id=$(tmux display-message -p '#{pane_id}')
fi

# Only toggle for Claude Code panes (pane_current_command is a semver)
cmd=$(tmux display-message -t "$pane_id" -p '#{pane_current_command}')
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    exit 0
fi

cwtctl auto-yes toggle "$pane_id" &>/dev/null &
