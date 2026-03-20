#!/usr/bin/env bash
# Toggle auto-yes for the current tmux pane

pane_id="$TMUX_PANE"
if [ -z "$pane_id" ]; then
    pane_id=$(tmux display-message -p '#{pane_id}')
fi

cwtctl auto-yes toggle "$pane_id" &>/dev/null &
