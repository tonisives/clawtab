#!/usr/bin/env bash
# Display a popup centered within the target pane.

PANE_ID="$1"
REQUESTED_W="$2"
REQUESTED_H="$3"
shift 3

if [ -z "$PANE_ID" ] || [ -z "$REQUESTED_W" ] || [ -z "$REQUESTED_H" ] ||
    [ "$#" -eq 0 ]; then
    exit 1
fi

# run-shell can strip the leading percent from a pane ID.
[[ "$PANE_ID" != %* ]] && PANE_ID="%$PANE_ID"

geometry=$(tmux display-message -t "$PANE_ID" -p \
    '#{pane_left} #{pane_top} #{pane_width} #{pane_height} #{client_width} #{client_height}' \
    2>/dev/null) || geometry=""
read -r PANE_X PANE_Y PANE_W PANE_H CLIENT_W CLIENT_H <<< "$geometry"

if ! [[ "$PANE_X" =~ ^[0-9]+$ && "$PANE_Y" =~ ^[0-9]+$ &&
    "$PANE_W" =~ ^[0-9]+$ && "$PANE_H" =~ ^[0-9]+$ &&
    "$CLIENT_W" =~ ^[0-9]+$ && "$CLIENT_H" =~ ^[0-9]+$ ]]; then
    tmux display-popup -E -w "$REQUESTED_W" -h "$REQUESTED_H" "$@"
    exit $?
fi

case "$REQUESTED_W" in
    *%) POPUP_W=$((CLIENT_W * ${REQUESTED_W%%%} / 100)) ;;
    *) POPUP_W="$REQUESTED_W" ;;
esac

case "$REQUESTED_H" in
    *%) POPUP_H=$((CLIENT_H * ${REQUESTED_H%%%} / 100)) ;;
    *) POPUP_H="$REQUESTED_H" ;;
esac

[[ "$POPUP_W" =~ ^[0-9]+$ ]] || POPUP_W="$CLIENT_W"
[[ "$POPUP_H" =~ ^[0-9]+$ ]] || POPUP_H="$CLIENT_H"

# Keep the popup inside the pane so its center remains tied to the pane.
[ "$POPUP_W" -gt "$PANE_W" ] && POPUP_W="$PANE_W"
[ "$POPUP_H" -gt "$PANE_H" ] && POPUP_H="$PANE_H"
[ "$POPUP_W" -lt 1 ] && POPUP_W=1
[ "$POPUP_H" -lt 1 ] && POPUP_H=1

POPUP_X=$((PANE_X + (PANE_W - POPUP_W) / 2))
POPUP_Y=$((PANE_Y + (PANE_H - POPUP_H) / 2))

tmux display-popup -E \
    -x "$POPUP_X" -y "$POPUP_Y" \
    -w "$POPUP_W" -h "$POPUP_H" \
    "$@"
