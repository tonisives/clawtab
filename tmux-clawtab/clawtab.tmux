#!/usr/bin/env bash
# ClawTab tmux plugin
#
# Install: add to .tmux.conf:
#   run-shell /path/to/clawtab.tmux
#
# Keybindings:
#   prefix + E   ClawTab menu (auto-yes, secrets, skills) with [ ] tab switching
#   prefix + y   Toggle auto-yes for current pane
#   prefix + o   Open current pane in ClawTab desktop
#   prefix + s   Search skills with fzf and insert /skill-name
#   prefix + f   Fork current Claude Code session into new pane below
#
# Pane title bar (top, right side):
#   [Y] green=on, dim=off - only shown for supported agent panes

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Warn if cwtctl is missing - auto-yes sync silently fails without it.
if ! command -v cwtctl >/dev/null 2>&1; then
    tmux display-message "clawtab: cwtctl not in PATH - auto-yes sync disabled. Run 'make build-cwtctl'."
fi

# Key bindings (customizable via @clawtab-auto-yes-key, @clawtab-open-key)
auto_yes_key=$(tmux show-option -gqv @clawtab-auto-yes-key)
open_key=$(tmux show-option -gqv @clawtab-open-key)
: "${auto_yes_key:=y}"
: "${open_key:=o}"

skills_key=$(tmux show-option -gqv @clawtab-skills-key)
: "${skills_key:=s}"

fork_key=$(tmux show-option -gqv @clawtab-fork-key)
: "${fork_key:=f}"

menu_key=$(tmux show-option -gqv @clawtab-menu-key)
: "${menu_key:=E}"

sidebar_key=$(tmux show-option -gqv @clawtab-sidebar-key)
: "${sidebar_key:=\`}"

tmux bind-key "$menu_key" run-shell "$CURRENT_DIR/scripts/popup-menu-launcher.sh '#{pane_id}'"
tmux bind-key "$auto_yes_key" run-shell "$CURRENT_DIR/scripts/toggle-auto-yes.sh"
tmux bind-key "$open_key" run-shell "$CURRENT_DIR/scripts/open-clawtab.sh"
tmux bind-key "$skills_key" run-shell "$CURRENT_DIR/scripts/search-skills-launcher.sh '#{pane_id}'"
tmux bind-key "$fork_key" run-shell "$CURRENT_DIR/scripts/fork-session.sh '#{pane_id}'"
tmux bind-key "$sidebar_key" run-shell "$CURRENT_DIR/scripts/sidebar-launcher.sh '#{pane_id}'"

# Keep per-window agent activity synchronized from the daemon's IPC event
# stream. Re-sourcing replaces an older listener so script changes take effect
# in an existing tmux server.
listener_command="$(printf '%q' "$CURRENT_DIR/scripts/agent-status-listener.sh") --replace"
tmux run-shell -b "$listener_command"

# Append auto-yes indicator to pane-border-format (right-aligned)
# Uses pane option @clawtab-auto-yes for instant toggle feedback (no shell cache delay)
current_border=$(tmux show-option -gqv pane-border-format)
if [[ "$current_border" != *"clawtab-auto-yes"* ]]; then
    clawtab_part="#[align=right]#{?#{==:#{@clawtab-auto-yes},1},#[fg=green#,bold][Y]#[default],#{?#{||:#{m:*.*.*,#{pane_current_command}},#{||:#{m:*codex*,#{pane_current_command}},#{m:*claude*,#{pane_current_command}}}},#[fg=colour240][y]#[default],}}"
    tmux set-option -g pane-border-format "${current_border}${clawtab_part}"
fi

# Append activity indicators without replacing a user's existing window
# formats. The custom window options are updated by agent-status-listener.sh.
spinner_command=$(printf '%q' "$CURRENT_DIR/scripts/agent-spinner.sh")
clawtab_activity_part="#{?#{@clawtab-agent-question}, #[fg=yellow#,bold]!#[default],}#{?#{@clawtab-agent-working}, #[fg=cyan]#(${spinner_command})#[default],}#{?#{@clawtab-agent-present}, #[fg=green#,bold]✓#[default],}"
clawtab_idle_part="#{?#{@clawtab-agent-present}, #[fg=green#,bold]✓#[default],}"
legacy_clawtab_activity_part="#{?#{@clawtab-agent-question},#[fg=red#,bold]!#[default],#{?#{@clawtab-agent-working},#[fg=cyan]#(${spinner_command})#[default],#{?#{@clawtab-agent-present},#[fg=green#,bold]✓#[default],}}}"
legacy_clawtab_basic_part="#{?#{@clawtab-agent-question},#[fg=red#,bold]!#[default],}#{?#{@clawtab-agent-working},#[fg=cyan]#(${spinner_command})#[default],}"

append_activity_format() {
    local option_name="$1"
    local current_format
    current_format=$(tmux show-option -gqv "$option_name")

    # Do not append the current indicators more than once when the plugin is
    # reloaded.
    if [[ "$current_format" == *"$clawtab_activity_part"* ]]; then
        return
    fi

    # Upgrade the previous indicator format in place so color and padding
    # changes also reach an already-running tmux server.
    if [[ "$current_format" == *"$legacy_clawtab_activity_part"* ]]; then
        current_format="${current_format/"$legacy_clawtab_activity_part"/"$clawtab_activity_part"}"
        tmux set-option -g "$option_name" "$current_format"
        return
    fi
    if [[ "$current_format" == *"$legacy_clawtab_basic_part"* ]]; then
        current_format="${current_format/"$legacy_clawtab_basic_part"/"$clawtab_activity_part"}"
        tmux set-option -g "$option_name" "$current_format"
        return
    fi

    # Upgrade a status format installed by an older plugin version without
    # duplicating its ! and spinner indicators.
    if [[ "$current_format" == *"clawtab-agent-question"* && "$current_format" == *"clawtab-agent-working"* ]]; then
        tmux set-option -g "$option_name" "${current_format}${clawtab_idle_part}"
    else
        tmux set-option -g "$option_name" "${current_format}${clawtab_activity_part}"
    fi
}

append_activity_format window-status-format
append_activity_format window-status-current-format

# Note: MouseDown1Border would conflict with drag-to-resize, so no border click binding.
# Use prefix + y (or configured key) to toggle auto-yes.

# Refresh the status line every second so the spinner animates.
tmux set-option -g status-interval 1
