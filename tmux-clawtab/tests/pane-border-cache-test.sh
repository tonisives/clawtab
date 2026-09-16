#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/.."
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

cat >"$TEST_DIR/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
    display-message)
        printf '@42\n'
        ;;
    list-clients)
        printf '%s\n' "$@" >>"$TEST_TMUX_OPTIONS"
        printf '/dev/test-client\n'
        ;;
    list-panes)
        printf '%s\n' "$@" >>"$TEST_TMUX_OPTIONS"
        printf '%%63|||120\n'
        ;;
    refresh-client)
        printf '%s\n' "$@" >>"$TEST_TMUX_OPTIONS"
        ;;
    show-option)
        if [ "${3:-}" = "pane-border-format" ]; then
            printf '%s\n' "$TEST_BORDER_FORMAT"
        fi
        ;;
    set-option)
        printf '%s\n' "$@" >>"$TEST_TMUX_OPTIONS"
        ;;
esac
EOF
cat >"$TEST_DIR/helper" <<'EOF'
#!/usr/bin/env bash
if [ "${3:-}" = "--path" ]; then
    printf '/workspace/project\n'
else
    printf '1h ago | holders perf\n'
fi
EOF
chmod +x "$TEST_DIR/tmux" "$TEST_DIR/helper"
export PATH="$TEST_DIR:$PATH"
export TEST_TMUX_OPTIONS="$TEST_DIR/options"
export CLAWTAB_PANE_INFO_HELPER="$TEST_DIR/helper"

bash "$PLUGIN_DIR/scripts/pane-border-cache.sh" '%63' 427
grep -Fxq '1h ago | holders perf' "$TEST_TMUX_OPTIONS"
grep -Fxq '@clawtab-pane-has-info' "$TEST_TMUX_OPTIONS"
grep -Fxq 'refresh-client' "$TEST_TMUX_OPTIONS"
grep -Fxq '/dev/test-client' "$TEST_TMUX_OPTIONS"
grep -Fq '#{==:#{window_id},@42}' "$TEST_TMUX_OPTIONS"
grep -Fq '#{!:#{client_control_mode}}' "$TEST_TMUX_OPTIONS"

# A background window refresh must enumerate the hook's explicit target.
: >"$TEST_TMUX_OPTIONS"
bash "$PLUGIN_DIR/scripts/pane-border-cache.sh" --window '@42'
grep -Fxq '@42' "$TEST_TMUX_OPTIONS"
grep -Fxq '1h ago | holders perf' "$TEST_TMUX_OPTIONS"
grep -Fxq 'refresh-client' "$TEST_TMUX_OPTIONS"

# All supported helper locations must become pane options, including the
# relocated helper used by existing tmux configurations.
for helper in '~/.config/tmux/clawtab-pane-info.sh' \
    "$HOME/.config/tmux/clawtab-pane-info.sh" \
    '~/.config/tmux/scripts/panes/clawtab-pane-info.sh' \
    "$HOME/.config/tmux/scripts/panes/clawtab-pane-info.sh"; do
    base="#(${helper} '#{pane_id}' '#{pane_width}'"
    export TEST_BORDER_FORMAT="${base} --path) #{?${base} --has-info),${base}),}"
    : >"$TEST_TMUX_OPTIONS"
    bash "$PLUGIN_DIR/clawtab.tmux"
    grep -Fq '#{@clawtab-pane-path}' "$TEST_TMUX_OPTIONS"
    grep -Fq '#{@clawtab-pane-info}' "$TEST_TMUX_OPTIONS"
    grep -Fq '#{@clawtab-pane-has-info}' "$TEST_TMUX_OPTIONS"
    if grep -Fq '#(' "$TEST_TMUX_OPTIONS"; then
        printf 'pane border still invokes a shell helper: %s\n' "$helper" >&2
        exit 1
    fi
done

# Exercise the listener's real event decoder without starting a listener.
JQ_BIN="$(command -v jq)"
sed -n '/^snapshot_action_for_event() {/,/^}/p' "$PLUGIN_DIR/scripts/agent-status-listener.sh" >"$TEST_DIR/event-decoder.sh"
source "$TEST_DIR/event-decoder.sh"
action=$(snapshot_action_for_event '{"PaneDisplayNameChanged":{"pane_id":"%63","display_name":"holders perf"}}')
[ "$(printf '%s' "$action" | jq -r '.RefreshPaneBorder')" = '%63' ]
action=$(snapshot_action_for_event '{"PaneDisplayNameChanged":{"pane_id":"%63","display_name":null}}')
[ "$(printf '%s' "$action" | jq -r '.RefreshPaneBorder')" = '%63' ]

printf 'pane-border-cache tests passed\n'
