#!/usr/bin/env bash
# Run the ClawTab menu in a native floating tmux pane. Unlike display-popup,
# this overlays its agent pane without locking the rest of the tmux client.

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run_control_pane() {
    local target_pane="$1"
    local control_pane="${TMUX_PANE:-}"
    local pane_file

    if [ -z "$control_pane" ]; then
        exit 1
    fi

    tmux set-option -p -t "$control_pane" remain-on-exit off
    tmux set-option -p -t "$control_pane" @clawtab-control-for "$target_pane"
    tmux select-pane -t "$control_pane" -T "ClawTab $target_pane"

    pane_file=$(mktemp /tmp/clawtab-pane-XXXXXX)
    trap 'rm -f "$pane_file"' EXIT
    printf '%s\n' "$target_pane" > "$pane_file"
    "$CURRENT_DIR/popup-menu.sh" "$pane_file"
}

if [ "${1:-}" = "--run" ]; then
    run_control_pane "$2"
    exit $?
fi

PANE_ID="$1"
[[ "$PANE_ID" != %* ]] && PANE_ID="%$PANE_ID"

# Invoking the menu while its floating pane is focused should resolve back to
# the agent pane instead of nesting another floating pane.
OWNER_PANE=$(tmux show-option -pqv -t "$PANE_ID" @clawtab-control-for 2>/dev/null || true)
if [ -n "$OWNER_PANE" ]; then
    PANE_ID="$OWNER_PANE"
fi

if ! tmux display-message -t "$PANE_ID" -p '#{pane_id}' >/dev/null 2>&1; then
    tmux display-message "clawtab: pane $PANE_ID no longer exists"
    exit 1
fi

# Reuse the floating pane already attached to this agent pane.
while read -r existing_pane owner_pane; do
    if [ "$owner_pane" = "$PANE_ID" ]; then
        existing_window=$(tmux display-message -t "$existing_pane" -p '#{window_id}')
        tmux select-window -t "$existing_window"
        tmux select-pane -t "$existing_pane"
        exit 0
    fi
done < <(tmux list-panes -a -F '#{pane_id} #{@clawtab-control-for}')

PANE_GEOMETRY=$(tmux display-message -t "$PANE_ID" -p \
    '#{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_current_path}')
read -r PANE_X PANE_Y PANE_WIDTH PANE_HEIGHT PANE_PATH <<< "$PANE_GEOMETRY"

MENU_SIZE=$(tmux show-option -gqv @clawtab-menu-size)
: "${MENU_SIZE:=95}"
if ! [[ "$MENU_SIZE" =~ ^[0-9]+$ ]] || [ "$MENU_SIZE" -lt 40 ] || [ "$MENU_SIZE" -gt 100 ]; then
    MENU_SIZE=95
fi

printf -v CONTROL_COMMAND '%q --run %q' "$CURRENT_DIR/control-pane-launcher.sh" "$PANE_ID"

# Native floating panes were added with the new-pane command. Fall back to the
# original popup on older tmux versions rather than changing the tiled layout.
if ! tmux list-commands | grep -q '^new-pane '; then
    exec "$CURRENT_DIR/popup-menu-launcher.sh" "$PANE_ID"
fi

CONTROL_WIDTH=$((PANE_WIDTH * MENU_SIZE / 100))
CONTROL_HEIGHT=$((PANE_HEIGHT * MENU_SIZE / 100))
[ "$CONTROL_WIDTH" -lt 1 ] && CONTROL_WIDTH=1
[ "$CONTROL_HEIGHT" -lt 1 ] && CONTROL_HEIGHT=1

CONTROL_X=$((PANE_X + (PANE_WIDTH - CONTROL_WIDTH) / 2))
CONTROL_Y=$((PANE_Y + (PANE_HEIGHT - CONTROL_HEIGHT) / 2))

NEW_PANE=$(tmux new-pane -t "$PANE_ID" -c "$PANE_PATH" \
    -x "$CONTROL_WIDTH" -y "$CONTROL_HEIGHT" \
    -X "$CONTROL_X" -Y "$CONTROL_Y" \
    -P -F '#{pane_id}' "$CONTROL_COMMAND")

if [ -z "$NEW_PANE" ]; then
    tmux display-message "clawtab: failed to create floating menu for $PANE_ID"
    exit 1
fi

# Tag immediately so a second invocation reuses this floating pane even while
# its TUI is still starting.
tmux set-option -p -t "$NEW_PANE" @clawtab-control-for "$PANE_ID"
tmux set-option -p -t "$NEW_PANE" remain-on-exit off
tmux select-pane -t "$NEW_PANE"
