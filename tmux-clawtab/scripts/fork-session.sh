#!/usr/bin/env bash
# Fork or restore the current agent session into a new pane below.

pane_id="${1:-$TMUX_PANE}"
if [ -z "$pane_id" ]; then
    pane_id=$(tmux display-message -p '#{pane_id}')
fi
[[ "$pane_id" != %* ]] && pane_id="%$pane_id"

cmd=$(tmux display-message -t "$pane_id" -p '#{pane_current_command}')

# Get the working directory of the current pane
pane_path=$(tmux display-message -t "$pane_id" -p '#{pane_current_path}')

restore_command=""
if command -v cwtctl >/dev/null 2>&1; then
    restore_command=$(cwtctl pane-info restore-command "$pane_id" 2>/dev/null || true)
fi

case "$restore_command" in
    codex\ *|opencode\ *)
        tmux split-window -v -t "$pane_id" -c "$pane_path" "$restore_command"
        exit 0
        ;;
esac

if echo "$cmd" | grep -qiE 'codex|opencode'; then
    if ! command -v cwtctl >/dev/null 2>&1; then
        tmux display-message "clawtab: cwtctl not found in PATH - cannot restore agent session"
        exit 1
    fi
    if [ -z "$restore_command" ]; then
        tmux display-message "clawtab: no restore command found for pane $pane_id"
        exit 1
    fi
    tmux split-window -v -t "$pane_id" -c "$pane_path" "$restore_command"
    exit 0
fi

if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' && ! echo "$cmd" | grep -qi 'claude'; then
    tmux display-message "clawtab: no fork command for pane $pane_id"
    exit 0
fi

# Touch the JSONL by sending "forking" + ESC ESC to make this the most recent session
tmux send-keys -t "$pane_id" "forking" Enter Escape Escape
sleep 0.5

# Fork using --continue (picks up the most recent session in cwd)
tmux split-window -v -t "$pane_id" -c "$pane_path" "claude --continue --fork-session"
