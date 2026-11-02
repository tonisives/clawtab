#!/usr/bin/env bash
# Toggle auto-yes for the current tmux pane.

pane_id="${1:-$TMUX_PANE}"
if [ -z "$pane_id" ]; then
    pane_id=$(tmux display-message -p '#{pane_id}')
fi

# Only toggle for supported agent panes.
cmd=$(tmux display-message -t "$pane_id" -p '#{pane_current_command}')
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' && ! echo "$cmd" | grep -qiE 'claude|codex'; then
    exit 0
fi

# Sync state with desktop app / daemon. Do this BEFORE updating the tmux
# border option so the border only reflects state that the daemon agreed to.
# A silent failure here (e.g. cwt missing) would leave the [Y] indicator
# showing while the daemon never auto-answers.
if ! command -v cwt >/dev/null 2>&1; then
    tmux display-message "clawtab: cwt not found in PATH - run 'make cwt-build && make cwt-copy-local'"
    exit 1
fi

# Keep the confirmed state while showing that a toggle is in flight.
if [ "$(tmux show-option -pqvt "$pane_id" @clawtab-auto-yes-pending)" = 1 ]; then
    exit 0
fi
clear_pending() {
    tmux set-option -pqu -t "$pane_id" @clawtab-auto-yes-pending
    tmux refresh-client -S
}
trap clear_pending EXIT
trap 'exit 1' HUP INT TERM
tmux set-option -pt "$pane_id" @clawtab-auto-yes-pending 1
tmux refresh-client -S

if ! out=$(cwt agent auto-yes toggle "$pane_id" 2>&1); then
    tmux display-message "clawtab: auto-yes toggle failed: $out"
    exit 1
fi

# Reconcile the pane-local indicator with the daemon's authoritative state.
# The daemon also writes this option so auto-yes survives daemon rebuilds.
if cwt agent auto-yes check "$pane_id" >/dev/null 2>&1; then
    tmux set-option -pt "$pane_id" @clawtab-auto-yes 1
else
    tmux set-option -pqu -t "$pane_id" @clawtab-auto-yes
fi
