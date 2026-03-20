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

# Get the shell PID for this pane, then find Claude as its child
shell_pid=$(tmux display-message -t "$pane_id" -p '#{pane_pid}')
claude_pid=$(pgrep -P "$shell_pid" | head -1)

if [ -z "$claude_pid" ]; then
    tmux display-message "Could not find Claude process"
    exit 0
fi

# Read session ID from Claude's session file
session_file="$HOME/.claude/sessions/${claude_pid}.json"
if [ ! -f "$session_file" ]; then
    tmux display-message "No session file for PID $claude_pid"
    exit 0
fi

session_id=$(python3 -c "import json; print(json.load(open('$session_file'))['sessionId'])" 2>/dev/null)
if [ -z "$session_id" ]; then
    tmux display-message "Could not read session ID"
    exit 0
fi

# Get the working directory of the current pane
pane_path=$(tmux display-message -t "$pane_id" -p '#{pane_current_path}')

# Split below and resume with fork
tmux split-window -v -c "$pane_path" "claude --resume '$session_id' --fork-session"
