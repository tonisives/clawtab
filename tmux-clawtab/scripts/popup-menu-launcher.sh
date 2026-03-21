#!/usr/bin/env bash
# Launcher: resolves pane_id via run-shell, then opens the popup
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANE_ID="$1"
# run-shell strips % from #{pane_id} - add it back if missing
[[ "$PANE_ID" != %* ]] && PANE_ID="%$PANE_ID"
# Write pane_id to temp file to avoid % escaping issues with tmux
PANE_FILE=$(mktemp /tmp/clawtab-pane-XXXXXX)
echo "$PANE_ID" > "$PANE_FILE"
tmux display-popup -E -w 60 -h 80% "$CURRENT_DIR/popup-menu.sh '$PANE_FILE'"
