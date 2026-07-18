#!/usr/bin/env bash
# Open the ClawTab menu in a non-modal floating pane by default. Set
# @clawtab-menu-mode to "popup" to retain the original client-modal behavior.

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANE_ID="$1"
[[ "$PANE_ID" != %* ]] && PANE_ID="%$PANE_ID"

MENU_MODE=$(tmux show-option -gqv @clawtab-menu-mode)
case "${MENU_MODE:-floating}" in
    floating|pane)
        exec "$CURRENT_DIR/control-pane-launcher.sh" "$PANE_ID"
        ;;
    popup)
        exec "$CURRENT_DIR/popup-menu-launcher.sh" "$PANE_ID"
        ;;
    *)
        tmux display-message "clawtab: invalid @clawtab-menu-mode '$MENU_MODE' (use floating or popup)"
        exit 1
        ;;
esac
