#!/usr/bin/env bash
# Launcher for cwttui-sidebar (tmux popup, left-anchored ~30% width, full height).
PANE_ID="$1"
[[ "$PANE_ID" != %* ]] && PANE_ID="%$PANE_ID"

TERM_W=$(tmux display-message -p '#{client_width}')
POPUP_W=$((TERM_W * 30 / 100))
[ "$POPUP_W" -lt 60 ] && POPUP_W=60
[ "$POPUP_W" -gt "$TERM_W" ] && POPUP_W="$TERM_W"

BIN=$(command -v cwttui-sidebar || true)
if [ -z "$BIN" ]; then
    tmux display-message "clawtab: cwttui-sidebar not in PATH"
    exit 1
fi

tmux display-popup -E -x 0 -y 0 -w "$POPUP_W" -h 100% "$BIN --pane '$PANE_ID'"
