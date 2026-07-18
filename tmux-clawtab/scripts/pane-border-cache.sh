#!/usr/bin/env bash

# Cache the user's richer ClawTab pane-border helper in pane options. Tmux can
# render pane options without starting a shell process on every redraw.
set -u

pane_id="${1:-}"
pane_width="${2:-}"
helper="${CLAWTAB_PANE_INFO_HELPER:-$HOME/.config/tmux/clawtab-pane-info.sh}"

[ -x "$helper" ] || exit 0

refresh_pane() {
    local target="$1"
    local width="$2"
    local path
    local info
    local has_info=0

    if ! [[ "$width" =~ ^[0-9]+$ ]]; then
        width="$(tmux display-message -p -t "$target" '#{pane_width}' 2>/dev/null || true)"
    fi
    path="$("$helper" "$target" "$width" --path 2>/dev/null || true)"
    info="$("$helper" "$target" "$width" 2>/dev/null || true)"
    [ -n "$info" ] && has_info=1

    # Values are expanded as tmux formats later, so escape literal hashes.
    path="${path//#/##}"
    info="${info//#/##}"
    tmux set-option -pq -t "$target" @clawtab-pane-path "$path" \
        \; set-option -pq -t "$target" @clawtab-pane-info "$info" \
        \; set-option -pq -t "$target" @clawtab-pane-has-info "$has_info" \
        2>/dev/null || true
}

if [ -n "$pane_id" ]; then
    refresh_pane "$pane_id" "$pane_width"
    exit 0
fi

# With no explicit target, refresh the panes in the currently selected window.
tmux list-panes -F '#{pane_id}|||#{pane_width}' 2>/dev/null |
    while IFS= read -r pane; do
        [ -n "$pane" ] || continue
        target="${pane%%|||*}"
        width="${pane#*|||}"
        refresh_pane "$target" "$width"
    done
