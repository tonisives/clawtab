#!/usr/bin/env bash

set -euo pipefail

mode="${1:-plain}"
interval="${2:-0.1}"

cleanup() {
    # End a synchronized update if the process was interrupted mid-frame,
    # then restore the cursor and leave the alternate screen.
    printf '\033[?2026l\033[?25h\033[?1049l'
}
trap cleanup EXIT INT TERM

printf '\033[?1049h\033[2J\033[H\033[?25l'

case "$mode" in
    plain) label="PLAIN" ;;
    sync) label="SYNC" ;;
    idle)
        printf 'IDLE CONTROL\n\nThis pane does not update.\n'
        while :; do sleep 3600; done
        ;;
    *)
        printf 'usage: %s plain|sync|idle [interval]\n' "$0" >&2
        exit 2
        ;;
esac

frame=0
while :; do
    frame=$((frame + 1))
    if [ "$mode" = "sync" ]; then
        printf '\033[?2026h'
    fi

    printf '\033[H'
    printf '%s OUTPUT\033[K\n\n' "$label"
    printf 'frame: %-12s\033[K\n' "$frame"
    printf 'interval: %ss\033[K\n' "$interval"
    printf 'tmux overlay repaint test\033[K\n\n'
    printf 'The content and cadence match the other updating pane.\033[K\n'
    printf 'Only DEC synchronized-output framing differs.\033[K\n'
    printf '\033[J'

    if [ "$mode" = "sync" ]; then
        printf '\033[?2026l'
    fi
    sleep "$interval"
done
