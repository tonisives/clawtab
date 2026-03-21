#!/usr/bin/env bash
# Fork the current Claude Code session into a new pane below

pane_id="$TMUX_PANE"
if [ -z "$pane_id" ]; then
    pane_id=$(tmux display-message -p '#{pane_id}')
fi

# Only fork Claude Code panes (pane_current_command is a semver)
cmd=$(tmux display-message -t "$pane_id" -p '#{pane_current_command}')
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    tmux display-message "Not a Claude Code pane"
    exit 0
fi

# Get the working directory of the current pane
pane_path=$(tmux display-message -t "$pane_id" -p '#{pane_current_path}')

# Touch the JSONL by sending "forking" + ESC ESC to make this the most recent session
tmux send-keys -t "$pane_id" "forking" Enter Escape Escape
sleep 0.5

# Fork using --continue (picks up the most recent session in cwd)
tmux split-window -v -c "$pane_path" "claude --continue --fork-session"
