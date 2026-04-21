#!/usr/bin/env bash
# Toggle auto-yes for the current tmux pane.

pane_id="${1:-$TMUX_PANE}"
if [ -z "$pane_id" ]; then
    pane_id=$(tmux display-message -p '#{pane_id}')
fi

# Only toggle for supported agent panes.
cmd=$(tmux display-message -t "$pane_id" -p '#{pane_current_command}')
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' && ! echo "$cmd" | grep -qiE 'claude|codex'; then
    exit 0
fi

# Sync state with desktop app / daemon. Do this BEFORE updating the tmux
# border option so the border only reflects state that the daemon agreed to.
# A silent failure here (e.g. cwtctl missing) would leave the [Y] indicator
# showing while the daemon never auto-answers.
if ! command -v cwtctl >/dev/null 2>&1; then
    tmux display-message "clawtab: cwtctl not found in PATH - run 'make build-cwtctl'"
    exit 1
fi

if ! out=$(cwtctl auto-yes toggle "$pane_id" 2>&1); then
    tmux display-message "clawtab: auto-yes toggle failed: $out"
    exit 1
fi

# Toggle pane-local option (read instantly by border format, no shell cache delay)
current=$(tmux show-option -pqvt "$pane_id" @clawtab-auto-yes)
if [ "$current" = "1" ]; then
    tmux set-option -pt "$pane_id" @clawtab-auto-yes 0
else
    tmux set-option -pt "$pane_id" @clawtab-auto-yes 1
fi
