#!/usr/bin/env bash
# fzf popup to search and insert a /skill command into the current pane

SKILLS_DIR="$HOME/.claude/skills"
PANE_ID="$1"

if [ ! -d "$SKILLS_DIR" ]; then
    tmux display-message "No skills found in $SKILLS_DIR"
    exit 0
fi

# List skill directory names
skill=$(ls -1 "$SKILLS_DIR" 2>/dev/null | fzf --prompt="/ " --reverse --no-info)

if [ -n "$skill" ]; then
    tmux send-keys -t "$PANE_ID" "/$skill" Enter
fi
