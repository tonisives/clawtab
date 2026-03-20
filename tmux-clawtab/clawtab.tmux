#!/usr/bin/env bash
# ClawTab tmux plugin
#
# Install: add to .tmux.conf:
#   run-shell /path/to/clawtab.tmux
#
# Keybindings:
#   prefix + y   Toggle auto-yes for current pane
#   prefix + o   Open current pane in ClawTab desktop
#
# Pane title bar (top, right side):
#   [Y] green=on, dim=off - only shown for Claude Code panes

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Key bindings (customizable via @clawtab-auto-yes-key, @clawtab-open-key)
auto_yes_key=$(tmux show-option -gqv @clawtab-auto-yes-key)
open_key=$(tmux show-option -gqv @clawtab-open-key)
: "${auto_yes_key:=y}"
: "${open_key:=o}"

tmux bind-key "$auto_yes_key" run-shell "$CURRENT_DIR/scripts/toggle-auto-yes.sh"
tmux bind-key "$open_key" run-shell "$CURRENT_DIR/scripts/open-clawtab.sh"

# Append auto-yes indicator to pane-border-format (right-aligned)
current_border=$(tmux show-option -gqv pane-border-format)
if [[ "$current_border" != *"status-auto-yes"* ]]; then
    clawtab_part="#[align=right]#($CURRENT_DIR/scripts/status-auto-yes.sh '#{pane_id}' '#{pane_current_command}')"
    tmux set-option -g pane-border-format "${current_border}${clawtab_part}"
fi

# Mouse click on status-right toggles auto-yes
tmux bind-key -n MouseDown1StatusRight run-shell "$CURRENT_DIR/scripts/toggle-auto-yes.sh"

# Refresh pane borders every 5s so auto-yes indicator stays current
tmux set-option -g status-interval 5
