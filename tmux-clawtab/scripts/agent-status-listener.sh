#!/usr/bin/env bash

# Keep one listener per tmux server generation. Multiple tmux servers can run
# on the same machine (for example, a user's server and an overmind server),
# and a resurrected server must be able to start a fresh listener.
set -u

DAEMON_SOCKET="/tmp/clawtab.sock"
EVENT_SOCKET="/tmp/clawtab-events.sock"

tmux_server_socket="$(tmux display-message -p '#{socket_path}' 2>/dev/null || true)"
tmux_server_pid="$(tmux display-message -p '#{pid}' 2>/dev/null || true)"
if [ -n "${TMUX:-}" ]; then
    [ -n "$tmux_server_socket" ] || tmux_server_socket="${TMUX%%,*}"
    if [ -z "$tmux_server_pid" ]; then
        tmux_server_pid="${TMUX#*,}"
        tmux_server_pid="${tmux_server_pid%%,*}"
    fi
fi
tmux_server_identity="${tmux_server_socket}:${tmux_server_pid}"
if command -v shasum >/dev/null 2>&1; then
    lock_key="$(printf '%s' "$tmux_server_identity" | shasum -a 256 | cut -c1-16)"
else
    lock_key="$(printf '%s' "$tmux_server_identity" | tr '/:,' '___' | tr -cd '[:alnum:]_.-')"
fi
[ -n "$lock_key" ] || lock_key="default"
LOCK_DIR="/tmp/clawtab/tmux-agent-status-${lock_key}.lock"

JQ_BIN="$(command -v jq 2>/dev/null || true)"
if [ -z "$JQ_BIN" ]; then
    for candidate in /opt/homebrew/bin/jq /usr/local/bin/jq; do
        if [ -x "$candidate" ]; then
            JQ_BIN="$candidate"
            break
        fi
    done
fi
if [ -z "$JQ_BIN" ]; then
    exit 0
fi

mkdir -p /tmp/clawtab 2>/dev/null || exit 0
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    existing_pid=""
    if [ -f "$LOCK_DIR/pid" ]; then
        existing_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    fi
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
        exit 0
    fi
    rmdir "$LOCK_DIR" 2>/dev/null || exit 0
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
trap 'rm -f "$LOCK_DIR/pid"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

clear_activity_options() {
    tmux list-windows -a -F '#{window_id}' 2>/dev/null | while IFS= read -r window_id; do
        [ -n "$window_id" ] || continue
        tmux set-window-option -q -t "$window_id" @clawtab-agent-working 0 2>/dev/null || true
        tmux set-window-option -q -t "$window_id" @clawtab-agent-question 0 2>/dev/null || true
    done
}

apply_snapshot() {
    snapshot="$1"
    if ! printf '%s\n' "$snapshot" | "$JQ_BIN" -e 'has("AgentActivity")' >/dev/null 2>&1; then
        return 1
    fi

    clear_activity_options
    printf '%s\n' "$snapshot" | "$JQ_BIN" -r \
        '.AgentActivity[]? | [.pane_id, (.working | tostring), (.asking | tostring)] | @tsv' \
        2>/dev/null | while IFS=$'\t' read -r pane_id working asking; do
        [ -n "$pane_id" ] || continue
        window_id="$(tmux display-message -p -t "$pane_id" '#{window_id}' 2>/dev/null || true)"
        [ -n "$window_id" ] || continue

        if [ "$working" = "true" ]; then
            tmux set-window-option -q -t "$window_id" @clawtab-agent-working 1 2>/dev/null || true
        fi
        if [ "$asking" = "true" ]; then
            tmux set-window-option -q -t "$window_id" @clawtab-agent-question 1 2>/dev/null || true
        fi
    done
}

fetch_snapshot() {
    printf '"GetAgentActivity"\n' |
        nc -U -w 1 "$DAEMON_SOCKET" 2>/dev/null |
        head -n 1
}

clear_activity_options

while true; do
    if [ ! -S "$DAEMON_SOCKET" ] || [ ! -S "$EVENT_SOCKET" ]; then
        clear_activity_options
        sleep 2
        continue
    fi

    snapshot="$(fetch_snapshot)"
    if ! apply_snapshot "$snapshot"; then
        clear_activity_options
        sleep 2
        continue
    fi

    # The event payload contains the same snapshot, but fetching through the
    # request socket keeps this script independent of event JSON shape and
    # also handles question changes emitted by older daemons.
    nc -U "$EVENT_SOCKET" 2>/dev/null | while IFS= read -r _event; do
        next_snapshot="$(fetch_snapshot)"
        if ! apply_snapshot "$next_snapshot"; then
            clear_activity_options
        fi
    done

    clear_activity_options
    sleep 2
done
