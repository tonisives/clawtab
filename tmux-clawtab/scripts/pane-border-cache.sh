#!/usr/bin/env bash

# Cache the user's richer ClawTab pane-border helper in pane options. Tmux can
# render pane options without starting a shell process on every redraw.
set -u

pane_id="${1:-}"
pane_width="${2:-}"
window_id=""
if [ "$pane_id" = "--window" ]; then
    window_id="$pane_width"
    [ -n "$window_id" ] || exit 0
    pane_id=""
fi
helper="${CLAWTAB_PANE_INFO_HELPER:-}"
if [ -z "$helper" ]; then
    helper="$HOME/.config/tmux/scripts/panes/clawtab-pane-info.sh"
    [ -x "$helper" ] || helper="$HOME/.config/tmux/clawtab-pane-info.sh"
fi

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

    # User options alone do not reliably invalidate the rendered border.
    # Repaint only ordinary clients displaying this pane's window.
    local target_window
    local client
    target_window="$(tmux display-message -p -t "$target" '#{window_id}' 2>/dev/null || true)"
    [ -n "$target_window" ] || return 0
    while IFS= read -r client; do
        [ -n "$client" ] || continue
        tmux refresh-client -S -t "$client" 2>/dev/null || true
    done < <(tmux list-clients \
        -f "#{&&:#{==:#{window_id},$target_window},#{!:#{client_control_mode}}}" \
        -F '#{client_name}' 2>/dev/null)
}

if [ -n "$pane_id" ]; then
    refresh_pane "$pane_id" "$pane_width"
    exit 0
fi

# Hooks pass their window explicitly so concurrent clients cannot redirect work.
pane_args=()
[ -z "$window_id" ] || pane_args=(-t "$window_id")
tmux list-panes "${pane_args[@]}" -F '#{pane_id}|||#{pane_width}' 2>/dev/null |
    while IFS= read -r pane; do
        [ -n "$pane" ] || continue
        target="${pane%%|||*}"
        width="${pane#*|||}"
        refresh_pane "$target" "$width"
    done
