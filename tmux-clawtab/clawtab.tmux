#!/usr/bin/env bash
# ClawTab tmux plugin
#
# Install: add to .tmux.conf:
#   run-shell /path/to/clawtab.tmux
#
# Keybindings:
#   prefix + E   Floating ClawTab menu (auto-yes, secrets, skills)
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
    tmux display-message "clawtab: cwtctl not in PATH - auto-yes sync disabled. Run 'make cwtctl-build && make cwtctl-copy-local'."
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

tmux bind-key "$menu_key" run-shell "$CURRENT_DIR/scripts/menu-launcher.sh '#{pane_id}'"
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
border_cache_enabled=0
rewrite_pane_info_helper() {
    local helper_ref="$1"
    local base_call="#(${helper_ref} '#{pane_id}' '#{pane_width}'"
    local path_call="${base_call} --path)"
    local has_info_call="${base_call} --has-info)"
    local info_call="${base_call})"
    local path_cache='#{@clawtab-pane-path}'
    local has_info_cache='#{@clawtab-pane-has-info}'
    local info_cache='#{@clawtab-pane-info}'

    if [[ "$current_border" == *"$base_call"* ]]; then
        current_border="${current_border//$path_call/$path_cache}"
        current_border="${current_border//$has_info_call/$has_info_cache}"
        current_border="${current_border//$info_call/$info_cache}"
        border_cache_enabled=1
    fi
}
rewrite_pane_info_helper "~/.config/tmux/clawtab-pane-info.sh"
rewrite_pane_info_helper "$HOME/.config/tmux/clawtab-pane-info.sh"
if [[ "$current_border" == *"@clawtab-pane-path"* && "$current_border" == *"@clawtab-pane-info"* ]]; then
    border_cache_enabled=1
fi

if [[ "$current_border" != *"clawtab-auto-yes"* ]]; then
    clawtab_part="#[align=right]#{?#{==:#{@clawtab-auto-yes},1},#[fg=green#,bold][Y]#[default],#{?#{||:#{m:*.*.*,#{pane_current_command}},#{||:#{m:*codex*,#{pane_current_command}},#{m:*claude*,#{pane_current_command}}}},#[fg=colour240][y]#[default],}}"
    current_border="${current_border}${clawtab_part}"
fi
tmux set-option -g pane-border-format "$current_border"

if [ "$border_cache_enabled" -eq 1 ]; then
    pane_border_cache_script="$CURRENT_DIR/scripts/pane-border-cache.sh"
    tmux set-hook -g 'pane-focus-in[100]' \
        "run-shell -b '$pane_border_cache_script \"#{pane_id}\" \"#{pane_width}\"'"
    tmux set-hook -g 'after-select-window[100]' \
        "run-shell -b '$pane_border_cache_script'"
    tmux set-hook -g 'after-new-window[100]' \
        "run-shell -b '$pane_border_cache_script'"
    tmux set-hook -g 'after-split-window[100]' \
        "run-shell -b '$pane_border_cache_script'"
    tmux run-shell -b "$pane_border_cache_script"
fi

# Append activity indicators without replacing a user's existing window
# formats. The custom window options are updated by agent-status-listener.sh.
# Keep the old spinner format only for upgrading already-running tmux servers.
spinner_command=$(printf '%q' "$CURRENT_DIR/scripts/agent-spinner.sh")
clawtab_question_part="#{?#{@clawtab-agent-question},#[fg=yellow#,bold]!#[default],}"
clawtab_working_part="#{?#{@clawtab-agent-working},#{?#{@clawtab-agent-question}, ,}#[fg=cyan#,bold]*#[default],}"
clawtab_check_part="#{?#{@clawtab-agent-present},#{?#{@clawtab-agent-question},,#{?#{@clawtab-agent-working},,#[fg=green#,bold]✓#[default]}},}"
clawtab_activity_core="${clawtab_question_part}${clawtab_working_part}${clawtab_check_part}"
clawtab_activity_prefix="#{?#{||:#{@clawtab-agent-question},#{||:#{@clawtab-agent-working},#{@clawtab-agent-present}}}, ,}"
clawtab_activity_part="${clawtab_activity_prefix}${clawtab_activity_core}"
animated_clawtab_working_part="#{?#{@clawtab-agent-working},#{?#{@clawtab-agent-question}, ,}#[fg=cyan]#(${spinner_command})#[default],}"
animated_clawtab_activity_core="${clawtab_question_part}${animated_clawtab_working_part}${clawtab_check_part}"
previous_clawtab_activity_part="#{?#{@clawtab-agent-question}, #[fg=yellow#,bold]!#[default],}#{?#{@clawtab-agent-working}, #[fg=cyan]#(${spinner_command})#[default],}#{?#{@clawtab-agent-present}, #[fg=green#,bold]✓#[default],}"
legacy_clawtab_activity_part="#{?#{@clawtab-agent-question},#[fg=red#,bold]!#[default],#{?#{@clawtab-agent-working},#[fg=cyan]#(${spinner_command})#[default],#{?#{@clawtab-agent-present},#[fg=green#,bold]✓#[default],}}}"
legacy_clawtab_basic_part="#{?#{@clawtab-agent-question},#[fg=red#,bold]!#[default],}#{?#{@clawtab-agent-working},#[fg=cyan]#(${spinner_command})#[default],}"
had_animated_activity=0

activity_part_for_format() {
    local format="$1"
    if [[ "$format" == *" " ]]; then
        printf '%s' "$clawtab_activity_core"
    else
        printf '%s' "$clawtab_activity_part"
    fi
}

append_activity_format() {
    local option_name="$1"
    local current_format
    local base_format
    local activity_part
    current_format=$(tmux show-option -gqv "$option_name")

    # Do not append the current indicators more than once when the plugin is
    # reloaded.
    if [[ "$current_format" == *"$clawtab_activity_core"* ]]; then
        return
    fi

    if [[ "$current_format" == *"$animated_clawtab_activity_core"* ]]; then
        current_format="${current_format/"$animated_clawtab_activity_core"/"$clawtab_activity_core"}"
        tmux set-option -g "$option_name" "$current_format"
        had_animated_activity=1
        return
    fi

    if [[ "$current_format" == *"$previous_clawtab_activity_part"* ]]; then
        base_format="${current_format/"$previous_clawtab_activity_part"/}"
        activity_part="$(activity_part_for_format "$base_format")"
        tmux set-option -g "$option_name" "${base_format}${activity_part}"
        had_animated_activity=1
        return
    fi

    # Upgrade the previous indicator format in place so color and padding
    # changes also reach an already-running tmux server.
    if [[ "$current_format" == *"$legacy_clawtab_activity_part"* ]]; then
        base_format="${current_format/"$legacy_clawtab_activity_part"/}"
        activity_part="$(activity_part_for_format "$base_format")"
        tmux set-option -g "$option_name" "${base_format}${activity_part}"
        had_animated_activity=1
        return
    fi
    if [[ "$current_format" == *"$legacy_clawtab_basic_part"* ]]; then
        base_format="${current_format/"$legacy_clawtab_basic_part"/}"
        activity_part="$(activity_part_for_format "$base_format")"
        tmux set-option -g "$option_name" "${base_format}${activity_part}"
        had_animated_activity=1
        return
    fi

    # Upgrade a status format installed by an older plugin version without
    # duplicating its ! and spinner indicators.
    if [[ "$current_format" == *"clawtab-agent-question"* && "$current_format" == *"clawtab-agent-working"* ]]; then
        activity_part="$(activity_part_for_format "$current_format")"
        tmux set-option -g "$option_name" "${current_format}${activity_part}"
    else
        activity_part="$(activity_part_for_format "$current_format")"
        tmux set-option -g "$option_name" "${current_format}${activity_part}"
    fi
}

append_activity_format window-status-format
append_activity_format window-status-current-format

# Older plugin versions forced a one-second status refresh to animate the
# working marker. Restore tmux's default only when this load upgraded one of
# those animated formats, so a user's explicit interval remains untouched.
if [ "$had_animated_activity" -eq 1 ] && [ "$(tmux show-option -gqv status-interval)" = "1" ]; then
    tmux set-option -g status-interval 15
fi

# Note: MouseDown1Border would conflict with drag-to-resize, so no border click binding.
# Use prefix + y (or configured key) to toggle auto-yes.
