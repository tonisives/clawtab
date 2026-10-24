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
assert_age 259200 3d '#e88b8b'
assert_age 1123200 13d '#e88b8b'

# The cached pane helper renders the same live timestamp as a single-agent
# window, even if its session started earlier or its cached title contains hashes.
mkdir "$TEST_DIR/bin"
export REAL_TMUX="$(type -P tmux)" TEST_SOCKET
cat >"$TEST_DIR/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exec "$REAL_TMUX" -S "$TEST_SOCKET" "$@"
EOF
cat >"$TEST_DIR/helper" <<'EOF'
#!/usr/bin/env bash
if [ "${3:-}" = --path ]; then
    printf '/project\n'
else
    printf '3d ago | Task #{literal}\n'
fi
EOF
chmod +x "$TEST_DIR/bin/tmux" "$TEST_DIR/helper"
PATH="$TEST_DIR/bin:$PATH" CLAWTAB_PANE_INFO_HELPER="$TEST_DIR/helper" \
    bash "$SCRIPT_DIR/../scripts/pane-border-cache.sh" "$(tmux display-message -p '#{pane_id}')" 120
tmux set-option -g pane-border-format '#{E:@clawtab-pane-info}'
for seconds in 0 60 3600 86400 259200; do
    tmux set-option -p @clawtab-agent-pane-last-action-at "$((now - seconds))"
    case "$seconds" in
        0) expected='just now' ;;
        60) expected='1m ago' ;;
        3600) expected='1h ago' ;;
        86400) expected='1d ago' ;;
        259200) expected='3d ago' ;;
    esac
    [[ "$(tmux display-message -p '#{E:pane-border-format}')" == "$expected | Task #{literal}" ]]
done
tmux set-option -pu @clawtab-agent-pane-last-action-at
[[ "$(tmux display-message -p '#{E:pane-border-format}')" == 'Task #{literal}' ]]

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
