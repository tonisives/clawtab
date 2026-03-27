#!/usr/bin/env bash
# Launcher: resolves pane_id via run-shell, then opens the popup
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANE_ID="$1"
# run-shell strips % from #{pane_id} - add it back if missing
[[ "$PANE_ID" != %* ]] && PANE_ID="%$PANE_ID"
# Write pane_id to temp file to avoid % escaping issues with tmux
PANE_FILE=$(mktemp /tmp/clawtab-pane-XXXXXX)
echo "$PANE_ID" > "$PANE_FILE"
TERM_W=$(tmux display-message -p '#{window_width}')
POPUP_W=90
[ "$POPUP_W" -gt "$TERM_W" ] && POPUP_W="$TERM_W"
tmux display-popup -E -w "$POPUP_W" -h 95% "$CURRENT_DIR/popup-menu.sh '$PANE_FILE'"
