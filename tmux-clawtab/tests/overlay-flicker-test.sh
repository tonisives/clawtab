#!/usr/bin/env bash

set -euo pipefail

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRITER="$CURRENT_DIR/overlay-flicker-writer.sh"
WINDOW_NAME="overlay-flicker-test"

if [ -z "${TMUX:-}" ]; then
    printf 'Run this test from inside tmux.\n' >&2
    exit 1
fi

old_window="$(tmux list-windows -a -F '#{window_id} #{window_name}' |
    awk -v name="$WINDOW_NAME" '$2 == name { print $1; exit }')"
if [ -n "$old_window" ]; then
    tmux kill-window -t "$old_window"
fi

window_id="$(tmux new-window -d -P -F '#{window_id}' -n "$WINDOW_NAME" \
    "$WRITER plain")"
plain_pane="$(tmux list-panes -t "$window_id" -F '#{pane_id}' | head -n 1)"
sync_pane="$(tmux split-window -d -h -t "$plain_pane" -P -F '#{pane_id}' \
    "$WRITER sync")"
idle_pane="$(tmux split-window -d -v -t "$sync_pane" -P -F '#{pane_id}' \
    "$WRITER idle")"

tmux select-layout -t "$window_id" tiled >/dev/null
tmux select-window -t "$window_id"
tmux select-pane -t "$plain_pane"

tmux display-message \
    "overlay test: plain=$plain_pane sync=$sync_pane idle=$idle_pane; compare Shift-P numbers"
tmux display-panes -b -N -d 15000
