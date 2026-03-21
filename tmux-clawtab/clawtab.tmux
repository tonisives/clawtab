#!/usr/bin/env bash
# ClawTab tmux plugin
#
# Install: add to .tmux.conf:
#   run-shell /path/to/clawtab.tmux
#
# Keybindings:
#   prefix + y   Toggle auto-yes for current pane
#   prefix + o   Open current pane in ClawTab desktop
#   prefix + s   Search skills with fzf and insert /skill-name
#   prefix + f   Fork current Claude Code session into new pane below
#   prefix + E   Fork with secrets - pick secrets to inject into forked session
#
# Pane title bar (top, right side):
#   [Y] green=on, dim=off - only shown for Claude Code panes

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Key bindings (customizable via @clawtab-auto-yes-key, @clawtab-open-key)
auto_yes_key=$(tmux show-option -gqv @clawtab-auto-yes-key)
open_key=$(tmux show-option -gqv @clawtab-open-key)
: "${auto_yes_key:=y}"
: "${open_key:=o}"

skills_key=$(tmux show-option -gqv @clawtab-skills-key)
: "${skills_key:=s}"

fork_key=$(tmux show-option -gqv @clawtab-fork-key)
: "${fork_key:=f}"

secrets_key=$(tmux show-option -gqv @clawtab-secrets-key)
: "${secrets_key:=E}"

tmux bind-key "$auto_yes_key" run-shell "$CURRENT_DIR/scripts/toggle-auto-yes.sh"
tmux bind-key "$open_key" run-shell "$CURRENT_DIR/scripts/open-clawtab.sh"
tmux bind-key "$skills_key" display-popup -E -w 60 -h 80% "$CURRENT_DIR/scripts/search-skills.sh '#{pane_id}'"
tmux bind-key "$fork_key" run-shell "$CURRENT_DIR/scripts/fork-session.sh"
tmux bind-key "$secrets_key" run-shell "$CURRENT_DIR/scripts/fork-with-secrets-launcher.sh '#{pane_id}'"

# Append auto-yes indicator to pane-border-format (right-aligned)
# Uses pane option @clawtab-auto-yes for instant toggle feedback (no shell cache delay)
current_border=$(tmux show-option -gqv pane-border-format)
if [[ "$current_border" != *"clawtab-auto-yes"* ]]; then
    clawtab_part="#[align=right]#{?#{==:#{@clawtab-auto-yes},1},#[fg=green#,bold][Y]#[default],#{?#{m:*.*.*,#{pane_current_command}},#[fg=colour240][y]#[default],}}"
    tmux set-option -g pane-border-format "${current_border}${clawtab_part}"
fi

# Note: MouseDown1Border would conflict with drag-to-resize, so no border click binding.
# Use prefix + y (or configured key) to toggle auto-yes.

# Refresh pane borders every 5s so auto-yes indicator stays current
tmux set-option -g status-interval 5
