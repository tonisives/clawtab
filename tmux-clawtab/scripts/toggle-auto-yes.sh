#!/usr/bin/env bash
# Toggle auto-yes for the current tmux pane (only if it's a Claude Code pane)

pane_id="${1:-$TMUX_PANE}"
if [ -z "$pane_id" ]; then
    pane_id=$(tmux display-message -p '#{pane_id}')
fi

# Only toggle for Claude Code panes (pane_current_command is a semver)
cmd=$(tmux display-message -t "$pane_id" -p '#{pane_current_command}')
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    exit 0
fi

# Toggle pane-local option (read instantly by border format, no shell cache delay)
current=$(tmux show-option -pqvt "$pane_id" @clawtab-auto-yes)
if [ "$current" = "1" ]; then
    tmux set-option -pt "$pane_id" @clawtab-auto-yes 0
else
    tmux set-option -pt "$pane_id" @clawtab-auto-yes 1
fi

# Sync state with desktop app in background
cwtctl auto-yes toggle "$pane_id" &>/dev/null &
