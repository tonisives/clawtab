#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$(mktemp -d)"
TEST_SOCKET="$TEST_DIR/tmux.sock"
tmux() { command tmux -S "$TEST_SOCKET" "$@"; }
trap 'tmux kill-server 2>/dev/null || true; rm -rf "$TEST_DIR"' EXIT
tmux -f /dev/null new-session -d -s borders
first="$(tmux display-message -p '#{pane_id}')"
second="$(tmux split-window -h -P -F '#{pane_id}')"

# Use the actual border expression, without starting plugin listeners.
sed -n '/^pane_activity=/p' "$SCRIPT_DIR/../clawtab.tmux" >"$TEST_DIR/format.sh"
source "$TEST_DIR/format.sh"
tmux set-option -g pane-border-format "Title${pane_activity}"
tmux set-option -g @clawtab-daemon-running 1
tmux set-option -p -t "$first" @clawtab-agent-pane-present 1
tmux set-option -p -t "$second" @clawtab-agent-pane-present 1
tmux set-option -p -t "$second" @clawtab-agent-pane-working 1

render() { tmux display-message -p -t "$1" '#{E:pane-border-format}' | sed -E 's/#\[[^]]*\]//g'; }
[[ "$(render "$first")" == 'Title ✓' ]]
[[ "$(render "$second")" == 'Title *' ]]
tmux set-option -p -t "$first" @clawtab-agent-asking 1
[[ "$(render "$first")" == 'Title !' ]]
[[ "$(render "$second")" == 'Title *' ]]
tmux set-option -p -t "$first" @clawtab-agent-pane-alert 1
[[ "$(render "$first")" == 'Title !' ]]
tmux set-option -p -t "$first" @clawtab-agent-pane-present 0
[[ "$(render "$first")" == 'Title' ]]
tmux set-option -g @clawtab-daemon-running 0
[[ "$(render "$second")" == 'Title' ]]
# Expand the real cached age format at wide and narrow pane widths.
cat >"$TEST_DIR/helper" <<'EOF'
#!/bin/bash
[ "${3:-}" = --path ] || printf '2h ago | Title\n'
EOF
chmod +x "$TEST_DIR/helper"
export -f tmux
export TEST_SOCKET
CLAWTAB_PANE_INFO_HELPER="$TEST_DIR/helper" bash "$SCRIPT_DIR/../scripts/pane-border-cache.sh" "$first" 120
tmux set-option -p -t "$first" @clawtab-agent-pane-last-action-at "$(($(date +%s) - 7200))"
tmux resize-window -x 240
[[ "$(tmux display-message -p -t "$first" '#{E:@clawtab-pane-info}')" == 'Title | 2h ago' ]]
tmux resize-window -x 80
[[ "$(tmux display-message -p -t "$first" '#{E:@clawtab-pane-info}')" == 'Title | 2h' ]]
printf 'pane activity tests passed\n'
