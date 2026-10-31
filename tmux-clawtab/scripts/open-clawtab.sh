#!/usr/bin/env bash
# Open current tmux pane in ClawTab desktop

pane_id="$TMUX_PANE"
if [ -z "$pane_id" ]; then
    pane_id=$(tmux display-message -p '#{pane_id}')
fi

if ! command -v cwt &>/dev/null; then
    tmux display-message "cwt not found"
    exit 1
fi

result=$(cwt pane open "$pane_id" 2>&1)
if [ $? -ne 0 ]; then
    tmux display-message "ClawTab: $result"
fi
