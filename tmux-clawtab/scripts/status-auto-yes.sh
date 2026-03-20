#!/usr/bin/env bash
# Show auto-yes status in pane border - only for Claude Code panes
# Args: $1=pane_id $2=pane_current_command

pane_id="$1"
cmd="$2"

if [ -z "$pane_id" ] || [ -z "$cmd" ]; then
    exit 0
fi

# Only show for Claude Code panes (pane_current_command is a semver like 2.1.79)
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    exit 0
fi

# Use local flag file for instant response (avoids cwtctl/tokio startup overhead)
flag_file="/tmp/clawtab-auto-yes/${pane_id//\%/}"
if [ -f "$flag_file" ]; then
    echo "#[fg=green,bold][Y]#[default]"
else
    echo "#[fg=colour240][y]#[default]"
fi
