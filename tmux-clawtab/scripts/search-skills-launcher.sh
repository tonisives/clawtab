#!/usr/bin/env bash
# Launcher for the skills popup, centered within the current pane.

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANE_ID="$1"
# run-shell can strip the leading percent from a pane ID.
[[ "$PANE_ID" != %* ]] && PANE_ID="%$PANE_ID"

"$CURRENT_DIR/display-pane-popup.sh" "$PANE_ID" 60 80% \
    "$CURRENT_DIR/search-skills.sh" "$PANE_ID"
