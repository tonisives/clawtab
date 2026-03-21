#!/usr/bin/env bash
# Unified ClawTab popup with tabbed interface
# Tabs: Auto-yes | Secrets | Skills
# Switch tabs with arrow keys, close with Escape

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pane ID passed via temp file (avoids tmux % escaping issues)
PANE_FILE="$1"
if [ -z "$PANE_FILE" ] || [ ! -f "$PANE_FILE" ]; then
    echo "No pane ID"
    sleep 1
    exit 1
fi
PANE_ID=$(cat "$PANE_FILE")
rm -f "$PANE_FILE"

if [ -z "$PANE_ID" ]; then
    echo "No pane ID"
    sleep 1
    exit 1
fi

# Export for fzf subshells
export CLAWTAB_PANE_ID="$PANE_ID"
export CLAWTAB_SCRIPTS="$CURRENT_DIR"

# Verify it's a Claude Code pane
cmd=$(tmux list-panes -t "$PANE_ID" -F '#{pane_id} #{pane_current_command}' 2>/dev/null | grep "^${PANE_ID} " | cut -d' ' -f2)
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "Not a Claude Code pane"
    sleep 1
    exit 0
fi

export CLAWTAB_STATE_FILE=$(mktemp /tmp/clawtab-tab-XXXXXX)
META_FILE=$(mktemp /tmp/clawtab-meta-XXXXXX)
trap 'rm -f "$CLAWTAB_STATE_FILE" "$META_FILE"' EXIT

TAB=0
TABS=("Auto-yes" "Secrets" "Skills")

# Common fzf bind for tab switching (uses exported env vars)
TAB_BINDS=(
    --bind 'left:execute-silent(echo PREV > $CLAWTAB_STATE_FILE)+abort'
    --bind 'right:execute-silent(echo NEXT > $CLAWTAB_STATE_FILE)+abort'
)

render_header() {
    local tab=$1
    local h=""
    for i in 0 1 2; do
        if [ $i -eq $tab ]; then
            h+=" [${TABS[$i]}] "
        else
            h+="  ${TABS[$i]}  "
        fi
    done
    h+="\n  <- prev    -> next    esc close"
    echo -e "$h"
}

# Pre-resolve metadata for secrets tab
resolve_session() {
    pane_pid=$(tmux list-panes -t "$PANE_ID" -F '#{pane_id} #{pane_pid}' 2>/dev/null | grep "^${PANE_ID} " | cut -d' ' -f2)
    claude_pid=""
    for pid in $(pgrep -P "$pane_pid" 2>/dev/null); do
        local comm=$(ps -o comm= -p "$pid" 2>/dev/null)
        if [[ "$comm" == *claude* ]]; then
            claude_pid="$pid"
            break
        fi
        for child in $(pgrep -P "$pid" 2>/dev/null); do
            comm=$(ps -o comm= -p "$child" 2>/dev/null)
            if [[ "$comm" == *claude* ]]; then
                claude_pid="$child"
                break 2
            fi
        done
    done

    pane_path=$(tmux list-panes -t "$PANE_ID" -F '#{pane_id} #{pane_current_path}' 2>/dev/null | grep "^${PANE_ID} " | cut -d' ' -f2-)
    session_id=""

    if [ -n "$claude_pid" ]; then
        session_file="$HOME/.claude/sessions/${claude_pid}.json"
        if [ -f "$session_file" ]; then
            candidate=$(python3 -c "import json; print(json.load(open('$session_file'))['sessionId'])" 2>/dev/null)
            project_dir_name=$(echo "$pane_path" | sed 's|/|-|g')
            project_dir="$HOME/.claude/projects/${project_dir_name}"
            if [ -f "$project_dir/${candidate}.jsonl" ]; then
                session_id="$candidate"
            fi
        fi
        if [ -z "$session_id" ]; then
            project_dir_name=$(echo "$pane_path" | sed 's|/|-|g')
            project_dir="$HOME/.claude/projects/${project_dir_name}"
            if [ -d "$project_dir" ]; then
                session_id=$(ls -t "$project_dir"/*.jsonl 2>/dev/null | head -1 | xargs basename 2>/dev/null | sed 's/\.jsonl$//')
            fi
        fi
    fi
}

run_auto_yes_tab() {
    local header
    header=$(render_header 0)

    current=$(tmux show-option -pqvt "$PANE_ID" @clawtab-auto-yes)
    if [ "$current" = "1" ]; then
        label="  Auto-yes: ON"
    else
        label="  Auto-yes: OFF"
    fi

    clear
    echo "$header"
    echo ""
    echo "$label"
    echo ""
    echo "  enter: toggle    ->: next    esc: close"
    while true; do
        IFS= read -rsn1 key
        case "$key" in
            "") # Enter
                "$CURRENT_DIR/toggle-auto-yes.sh" "$PANE_ID"
                echo "TOGGLE" > "$CLAWTAB_STATE_FILE"
                return
                ;;
            $'\x1b') # Escape or arrow key
                read -rsn1 -t 0.1 key2
                if [ -z "$key2" ]; then
                    # Plain escape - exit
                    return
                fi
                read -rsn1 -t 0.1 key3
                case "$key3" in
                    C) echo "NEXT" > "$CLAWTAB_STATE_FILE"; return ;; # Right arrow
                    D) echo "PREV" > "$CLAWTAB_STATE_FILE"; return ;; # Left arrow
                esac
                ;;
        esac
    done
}

run_secrets_tab() {
    local header
    header=$(render_header 1)

    if ! command -v cwtctl &>/dev/null; then
        echo "cwtctl not found" | fzf --no-sort --no-info --reverse \
            --prompt="secrets> " --header="$header" "${TAB_BINDS[@]}"
        return
    fi

    secret_keys=$(cwtctl secrets 2>/dev/null)
    if [ -z "$secret_keys" ] || [ "$secret_keys" = "No secrets stored" ]; then
        echo "No secrets available" | fzf --no-sort --no-info --reverse \
            --prompt="secrets> " --header="$header" "${TAB_BINDS[@]}"
        return
    fi

    selected=$(echo "$secret_keys" | fzf --multi --no-sort --no-info --reverse \
        --prompt="secrets> " \
        --header="$header" \
        --bind "tab:toggle+down" \
        "${TAB_BINDS[@]}")

    if [ -n "$selected" ]; then
        if [ -z "$session_id" ]; then
            resolve_session
        fi

        if [ -z "$session_id" ]; then
            tmux display-message "Could not resolve conversation ID"
            return
        fi

        cat > "$META_FILE" << EOF
PANE_ID=$PANE_ID
SESSION_ID=$session_id
PANE_PATH=$pane_path
EOF
        echo "$selected" >> "$META_FILE"

        tmux run-shell -b "$CURRENT_DIR/fork-with-secrets-exec.sh '$META_FILE'"
        META_FILE="/dev/null"
        exit 0
    fi
}

run_skills_tab() {
    local header
    header=$(render_header 2)
    local skills_dir="$HOME/.claude/skills"

    if [ ! -d "$skills_dir" ]; then
        echo "No skills found" | fzf --no-sort --no-info --reverse \
            --prompt="/ " --header="$header" "${TAB_BINDS[@]}"
        return
    fi

    skill=$(ls -1 "$skills_dir" 2>/dev/null | fzf --no-sort --no-info --reverse \
        --prompt="/ " \
        --header="$header" \
        "${TAB_BINDS[@]}")

    if [ -n "$skill" ]; then
        tmux send-keys -t "$PANE_ID" "/$skill" Enter
        exit 0
    fi
}

# Main loop
while true; do
    > "$CLAWTAB_STATE_FILE"

    case $TAB in
        0) run_auto_yes_tab ;;
        1) run_secrets_tab ;;
        2) run_skills_tab ;;
    esac

    if [ -s "$CLAWTAB_STATE_FILE" ]; then
        action=$(cat "$CLAWTAB_STATE_FILE")
        case "$action" in
            PREV) TAB=$(( (TAB + 2) % 3 )) ;;
            NEXT) TAB=$(( (TAB + 1) % 3 )) ;;
            TOGGLE) ;;  # stay on same tab, re-render
        esac
        continue
    fi

    break
done
