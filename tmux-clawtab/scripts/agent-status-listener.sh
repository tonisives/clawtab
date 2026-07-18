#!/usr/bin/env bash

# Keep one listener per tmux server generation. Multiple tmux servers can run
# on the same machine (for example, a user's server and an overmind server),
# and a resurrected server must be able to start a fresh listener.
set -u

replace_existing=0
if [ "${1:-}" = "--replace" ]; then
    replace_existing=1
fi

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

tmux_server_is_alive() {
    current_identity="$(
        tmux -S "$tmux_server_socket" display-message -p '#{socket_path}:#{pid}' \
            2>/dev/null || true
    )"
    [ "$current_identity" = "$tmux_server_identity" ]
}

if command -v shasum >/dev/null 2>&1; then
    lock_key="$(printf '%s' "$tmux_server_identity" | shasum -a 256 | cut -c1-16)"
else
    lock_key="$(printf '%s' "$tmux_server_identity" | tr '/:,' '___' | tr -cd '[:alnum:]_.-')"
fi
[ -n "$lock_key" ] || lock_key="default"
LOCK_DIR="/tmp/clawtab/tmux-agent-status-${lock_key}.lock"
EVENT_PIPE="$LOCK_DIR/events"
ACTIVITY_TSV="$LOCK_DIR/activity.tsv"
PANE_STATE_FILE="$LOCK_DIR/pane-state"
OPTION_CHANGES_FILE="$LOCK_DIR/option-changes.tsv"

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

stop_listener_tree() {
    local pid="$1"
    local child
    local children

    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    for child in $children; do
        stop_listener_tree "$child"
    done
    kill -TERM "$pid" 2>/dev/null || true
}

mkdir -p /tmp/clawtab 2>/dev/null || exit 0
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    existing_pid=""
    if [ -f "$LOCK_DIR/pid" ]; then
        existing_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    fi
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
        if [ "$replace_existing" -ne 1 ]; then
            exit 0
        fi
        stop_listener_tree "$existing_pid"
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            kill -0 "$existing_pid" 2>/dev/null || break
            sleep 0.1
        done
        if kill -0 "$existing_pid" 2>/dev/null; then
            kill -KILL "$existing_pid" 2>/dev/null || true
        fi
    fi
    rm -f "$EVENT_PIPE" 2>/dev/null || true
    rm -f "$LOCK_DIR/pid" 2>/dev/null || true
    rmdir "$LOCK_DIR" 2>/dev/null || true
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"
event_nc_pid=""
cleanup() {
    if [ -n "$event_nc_pid" ]; then
        kill -TERM "$event_nc_pid" 2>/dev/null || true
    fi
    lock_pid="$(sed -n '1p' "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ "$lock_pid" = "$$" ]; then
        rm -f "$EVENT_PIPE" "$ACTIVITY_TSV" "$PANE_STATE_FILE" "$OPTION_CHANGES_FILE" 2>/dev/null || true
        rm -f "$LOCK_DIR/pid"
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

clear_activity_options() {
    tmux list-windows -a -F '#{window_id}' 2>/dev/null | while IFS= read -r window_id; do
        [ -n "$window_id" ] || continue
        tmux set-window-option -q -t "$window_id" @clawtab-agent-present 0 2>/dev/null || true
        tmux set-window-option -q -t "$window_id" @clawtab-agent-working 0 2>/dev/null || true
        tmux set-window-option -q -t "$window_id" @clawtab-agent-question 0 2>/dev/null || true
        tmux set-window-option -q -t "$window_id" @clawtab-agent-seen 0 2>/dev/null || true
        tmux set-window-option -q -t "$window_id" @clawtab-agent-present-next 0 2>/dev/null || true
        tmux set-window-option -q -t "$window_id" @clawtab-agent-working-next 0 2>/dev/null || true
        tmux set-window-option -q -t "$window_id" @clawtab-agent-question-next 0 2>/dev/null || true
    done
}

clear_agent_pane_title() {
    pane_id="$1"
    display_name="$(tmux show-option -pqv -t "$pane_id" @clawtab-display-name 2>/dev/null || true)"
    [ -n "$display_name" ] || return

    # cwtctl also removes the persisted process override, preventing this
    # agent's title from being reused if another agent starts in the pane.
    if command -v cwtctl >/dev/null 2>&1 &&
        cwtctl agent rename "$pane_id" "" >/dev/null 2>&1; then
        return
    fi

    # Keep the visible tmux state correct even when cwtctl is unavailable.
    tmux select-pane -t "$pane_id" -T "" 2>/dev/null || true
    tmux set-option -pqu -t "$pane_id" @clawtab-display-name 2>/dev/null || true
}

apply_snapshot() {
    snapshot="$1"
    if ! printf '%s\n' "$snapshot" | "$JQ_BIN" -e 'has("AgentActivity")' >/dev/null 2>&1; then
        return 1
    fi

    # Keep a non-empty first input so the portable awk FNR == NR idiom also
    # works when there are no agents in the snapshot.
    printf '__header__\tfalse\tfalse\n' >"$ACTIVITY_TSV"
    printf '%s\n' "$snapshot" | "$JQ_BIN" -r \
        '.AgentActivity[]? | [.pane_id, (.working | tostring), (.asking | tostring)] | @tsv' \
        2>/dev/null >>"$ACTIVITY_TSV" || return 1

    tmux list-panes -a -F '#{pane_id}|||#{window_id}|||#{@clawtab-agent-pane-present}|||#{@clawtab-agent-present}|||#{@clawtab-agent-working}|||#{@clawtab-agent-question}' \
        >"$PANE_STATE_FILE" 2>/dev/null || return 1

    awk -F '\t' '
        FNR == NR {
            if ($1 != "__header__") {
                desired_pane[$1] = 1
                desired_working[$1] = ($2 == "true")
                desired_asking[$1] = ($3 == "true")
            }
            next
        }
        {
            split($0, field, /\|\|\|/)
            pane = field[1]
            window = field[2]
            panes[pane] = 1
            pane_current[pane] = (field[3] == "1")
            windows[window] = 1
            if (!(window in window_initialized)) {
                window_initialized[window] = 1
                window_present_current[window] = (field[4] == "1")
                window_working_current[window] = (field[5] == "1")
                window_asking_current[window] = (field[6] == "1")
            }
            if (desired_pane[pane]) {
                window_present[window] = 1
                if (desired_working[pane]) window_working[window] = 1
                if (desired_asking[pane]) window_asking[window] = 1
            }
        }
        END {
            for (pane in panes) {
                wanted = desired_pane[pane] ? 1 : 0
                if (pane_current[pane] != wanted) {
                    print "pane", pane, wanted
                }
            }
            for (window in windows) {
                present = window_present[window] ? 1 : 0
                working = window_working[window] ? 1 : 0
                asking = window_asking[window] ? 1 : 0
                if (window_present_current[window] != present ||
                    window_working_current[window] != working ||
                    window_asking_current[window] != asking) {
                    print "window", window, present, working, asking
                }
            }
        }
    ' "$ACTIVITY_TSV" "$PANE_STATE_FILE" >"$OPTION_CHANGES_FILE" || return 1

    while IFS=$'\t' read -r kind target first second third; do
        case "$kind" in
            pane)
                if [ "$first" = "0" ]; then
                    clear_agent_pane_title "$target"
                fi
                tmux set-option -pq -t "$target" @clawtab-agent-pane-present "$first" 2>/dev/null || true
                ;;
            window)
                tmux set-window-option -q -t "$target" @clawtab-agent-present "$first" \
                    \; set-window-option -q -t "$target" @clawtab-agent-working "$second" \
                    \; set-window-option -q -t "$target" @clawtab-agent-question "$third" \
                    2>/dev/null || true
                ;;
        esac
    done <"$OPTION_CHANGES_FILE"
}

fetch_snapshot() {
    printf '"GetAgentActivity"\n' |
        nc -U -w 1 "$DAEMON_SOCKET" 2>/dev/null |
        head -n 1
}

# Keep the last successfully applied snapshot across short daemon/socket
# interruptions. Clearing immediately makes every window icon disappear one at
# a time, then reappear one at a time when the next fetch succeeds.
FAILURES_BEFORE_CLEAR=15
consecutive_failures=0
activity_was_cleared=0

record_snapshot_failure() {
    consecutive_failures=$((consecutive_failures + 1))
    if [ "$consecutive_failures" -ge "$FAILURES_BEFORE_CLEAR" ] &&
        [ "$activity_was_cleared" -eq 0 ]; then
        clear_activity_options
        activity_was_cleared=1
    fi
}

record_snapshot_success() {
    consecutive_failures=0
    activity_was_cleared=0
}

# Current daemons put the complete activity snapshot in the event itself. Only
# older QuestionsChanged events need a request-socket fetch. Ignoring unrelated
# events avoids a request burst when several tmux servers are subscribed.
snapshot_action_for_event() {
    printf '%s\n' "$1" | "$JQ_BIN" -c '
        if type == "object" and has("AgentActivityChanged") then
            {AgentActivity: .AgentActivityChanged}
        elif . == "QuestionsChanged" then
            {FetchAgentActivity: true}
        else
            empty
        end
    ' 2>/dev/null
}

while true; do
    # A listener can outlive the tmux server that launched it, so check the
    # exact server socket and generation before connecting to the event stream.
    if ! tmux_server_is_alive; then
        exit 0
    fi

    if [ ! -S "$DAEMON_SOCKET" ] || [ ! -S "$EVENT_SOCKET" ]; then
        record_snapshot_failure
        sleep 2
        continue
    fi

    snapshot="$(fetch_snapshot)"
    if ! apply_snapshot "$snapshot"; then
        record_snapshot_failure
        sleep 2
        continue
    fi
    record_snapshot_success

    rm -f "$EVENT_PIPE" 2>/dev/null || true
    if ! mkfifo "$EVENT_PIPE" 2>/dev/null; then
        sleep 2
        continue
    fi
    nc -U "$EVENT_SOCKET" >"$EVENT_PIPE" 2>/dev/null &
    event_nc_pid=$!
    while true; do
        if ! IFS= read -r -t 15 event; then
            # An idle event stream is normal. Keep the existing subscription
            # and avoid rebuilding every pane/window option on each timeout.
            if ! tmux_server_is_alive; then
                exit 0
            fi
            if ! kill -0 "$event_nc_pid" 2>/dev/null; then
                break
            fi
            continue
        fi

        action="$(snapshot_action_for_event "$event")"
        [ -n "$action" ] || continue

        if printf '%s\n' "$action" | "$JQ_BIN" -e 'has("FetchAgentActivity")' >/dev/null 2>&1; then
            next_snapshot="$(fetch_snapshot)"
        else
            next_snapshot="$action"
        fi

        # A transient event/request failure must not erase a known-good state.
        # The outer loop handles persistent failures with a grace period.
        apply_snapshot "$next_snapshot" || true
    done <"$EVENT_PIPE"
    kill -TERM "$event_nc_pid" 2>/dev/null || true
    wait "$event_nc_pid" 2>/dev/null || true
    event_nc_pid=""
    rm -f "$EVENT_PIPE" 2>/dev/null || true

    sleep 2
done
