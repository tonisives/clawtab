#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$(mktemp -d)"
TEST_SOCKET="$TEST_DIR/tmux.sock"
tmux() { command tmux -S "$TEST_SOCKET" "$@"; }
trap 'tmux kill-server 2>/dev/null || true; rm -rf "$TEST_DIR"' EXIT
tmux -f /dev/null new-session -d -s visits -n first
tmux set-option -g @clawtab-daemon-running 1
tmux set-option -w @clawtab-agent-present 1

# Exercise the real format installer without launching daemon listeners.
sed -n '/^# Append activity indicators/,/^# Older plugin versions forced/p' \
    "$SCRIPT_DIR/../clawtab.tmux" >"$TEST_DIR/formats.sh"
CURRENT_DIR="$SCRIPT_DIR/.."
tmux set-option -g window-status-format '#I:#W'
tmux set-option -g window-status-current-format 'custom #W '
source "$TEST_DIR/formats.sh"
normal=$(tmux show-option -gqv window-status-format)
current=$(tmux show-option -gqv window-status-current-format)
source "$TEST_DIR/formats.sh"
[[ "$(tmux show-option -gqv window-status-format)" == "$normal" ]]
[[ "$(tmux show-option -gqv window-status-current-format)" == "$current" ]]

now=$(date +%s)
assert_age() {
    local seconds="$1" expected="$2" color="$3" rendered
    tmux set-option -w @clawtab-agent-last-action-at "$((now - seconds))"
    rendered=$(tmux display-message -p '#{E:window-status-format}')
    [[ "$rendered" == "0:first #[fg=${color}]${expected}#[default] #[fg=green,bold]✓#[default]" ]] || {
        printf 'unexpected age format: %s\n' "$rendered" >&2
        exit 1
    }
    rendered=$(tmux display-message -p '#{E:window-status-current-format}')
    [[ "$rendered" == "custom first #[fg=${color}]${expected}#[default] #[fg=green,bold]✓#[default]" ]]
}
assert_age -60 jn '#a7c88d'
assert_age 0 jn '#a7c88d'
assert_age 60 1m '#a7c88d'
assert_age 780 13m '#a7c88d'
assert_age 3600 1h '#e5c07b'
assert_age 46800 13h '#e5c07b'
assert_age 86400 1d '#e88b8b'
assert_age 1123200 13d '#e88b8b'

# Changing focus timestamps or selecting windows cannot reset agent action age.
tmux set-option -w @clawtab-window-visited-at "$now"
assert_age 1123200 13d '#e88b8b'
tmux new-window -d -t visits -n second
tmux select-window -t visits:1
tmux select-window -t visits:0
assert_age 1123200 13d '#e88b8b'

# A window without a known action has only its existing agent status.
tmux set-option -wu @clawtab-agent-last-action-at
[[ "$(tmux display-message -p '#{E:window-status-format}')" == '0:first #[fg=green,bold]✓#[default]' ]]

# Reloading an installed focus-age format replaces it rather than appending.
tmux set-option -g window-status-format "#I:#W ${visit_part}${clawtab_activity_part}"
source "$TEST_DIR/formats.sh"
normal=$(tmux show-option -gqv window-status-format)
[[ "$normal" != *'@clawtab-window-visited-at'* ]]
[[ "$normal" == *'@clawtab-agent-last-action-at'* ]]
assert_age 780 13m '#a7c88d'
source "$TEST_DIR/formats.sh"
[[ "$(tmux show-option -gqv window-status-format)" == "$normal" ]]

printf 'window action age tests passed\n'
