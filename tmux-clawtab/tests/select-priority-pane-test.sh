#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/../scripts/select-priority-pane.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

cat >"$TEST_DIR/tmux" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
    list-panes)
        printf '%b' "${TMUX_TEST_PANES:-}"
        ;;
    select-pane)
        printf '%s\n' "${3:-}" >>"$TMUX_TEST_SELECTIONS"
        ;;
esac
EOF
chmod +x "$TEST_DIR/tmux"

export PATH="$TEST_DIR:$PATH"
export TMUX_TEST_SELECTIONS="$TEST_DIR/selections"

assert_selection() {
    local expected="$1"
    local panes="$2"
    local actual

    : >"$TMUX_TEST_SELECTIONS"
    TMUX_TEST_PANES="$panes" "$HELPER" '@1'
    actual="$(sed -n '1p' "$TMUX_TEST_SELECTIONS")"
    if [ "$actual" != "$expected" ]; then
        printf 'expected selection %s, got %s\n' "$expected" "${actual:-<none>}" >&2
        exit 1
    fi
}

assert_no_selection() {
    local panes="$1"

    : >"$TMUX_TEST_SELECTIONS"
    TMUX_TEST_PANES="$panes" "$HELPER" '@1'
    if [ -s "$TMUX_TEST_SELECTIONS" ]; then
        printf 'expected no selection, got %s\n' "$(sed -n '1p' "$TMUX_TEST_SELECTIONS")" >&2
        exit 1
    fi
}

assert_selection '%2' $'%1|||0|||1\n%2|||1|||0\n%3|||0|||0\n'
assert_selection '%3' $'%1|||1|||0\n%2|||0|||0\n%3|||1|||1\n'
assert_selection '%1' $'%1|||1|||0\n%2|||0|||1\n%3|||1|||0\n'
assert_no_selection $'%1|||0|||0\n%2|||0|||1\n'

printf 'select-priority-pane tests passed\n'
