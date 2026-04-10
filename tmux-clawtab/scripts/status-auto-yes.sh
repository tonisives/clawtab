#!/usr/bin/env bash
# Show auto-yes status in pane border for supported agent panes.
# Args: $1=pane_id $2=pane_current_command

pane_id="$1"
cmd="$2"

if [ -z "$pane_id" ] || [ -z "$cmd" ]; then
    exit 0
fi

# Only show for panes that support auto-yes.
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' && ! echo "$cmd" | grep -qiE 'claude|codex'; then
    exit 0
fi

# Use local flag file for instant response (avoids cwtctl/tokio startup overhead)
flag_file="/tmp/clawtab-auto-yes/${pane_id//\%/}"
if [ -f "$flag_file" ]; then
    echo "#[fg=green,bold][Y]#[default]"
else
    echo "#[fg=colour240][y]#[default]"
fi
