#!/usr/bin/env bash
# Unified ClawTab popup - lazygit-style TUI
# Tabs: 1=Auto-yes  2=Secrets  3=Skills
# Navigation: 1/2/3 or left/right to switch tabs, j/k or up/down to scroll
# Actions: enter to select, space to toggle (secrets multi-select), esc to close

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

# Verify it's a Claude Code pane
cmd=$(tmux list-panes -t "$PANE_ID" -F '#{pane_id} #{pane_current_command}' 2>/dev/null | grep "^${PANE_ID} " | cut -d' ' -f2)
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    echo "Not a Claude Code pane"
    sleep 1
    exit 0
fi

META_FILE=$(mktemp /tmp/clawtab-meta-XXXXXX)
trap 'rm -f "$META_FILE"' EXIT

# State
TAB=0
TABS=("Auto-yes" "Secrets" "Skills")
CURSOR=0
SCROLL=0

# Multi-select tracking (indices)
declare -a SECRET_SELECTED
declare -a SKILL_SELECTED

# Data arrays
declare -a SKILLS_LIST
declare -a SECRETS_LIST

# Load data
load_skills() {
    SKILLS_LIST=()
    SKILL_SELECTED=()
    local skills_dir="$HOME/.claude/skills"
    if [ -d "$skills_dir" ]; then
        while IFS= read -r line; do
            SKILLS_LIST+=("$line")
            SKILL_SELECTED+=(0)
        done < <(ls -1 "$skills_dir" 2>/dev/null)
    fi
}

load_secrets() {
    SECRETS_LIST=()
    SECRET_SELECTED=()
    if command -v cwtctl &>/dev/null; then
        local raw
        raw=$(cwtctl secrets 2>/dev/null)
        if [ -n "$raw" ] && [ "$raw" != "No secrets stored" ]; then
            while IFS= read -r line; do
                SECRETS_LIST+=("$line")
                SECRET_SELECTED+=(0)
            done <<< "$raw"
        fi
    fi
}

load_skills
load_secrets

# Terminal size
get_size() {
    LINES=$(tput lines 2>/dev/null || echo 24)
    COLS=$(tput cols 2>/dev/null || echo 60)
}

# Drawing helpers
move_to() { printf '\033[%d;%dH' "$1" "$2" >&3; }
clear_line() { printf '\033[2K' >&3; }
bold() { printf '\033[1m%s\033[0m' "$1" >&3; }
dim() { printf '\033[2m%s\033[0m' "$1" >&3; }
reverse_video() { printf '\033[7m%s\033[0m' "$1" >&3; }
green() { printf '\033[32m%s\033[0m' "$1" >&3; }
yellow() { printf '\033[33m%s\033[0m' "$1" >&3; }
cyan() { printf '\033[36m%s\033[0m' "$1" >&3; }

# Draw the tab bar
draw_tabs() {
    move_to 1 1
    clear_line
    local out=""
    for i in 0 1 2; do
        if [ $i -eq $TAB ]; then
            out+=" $(reverse_video " ${TABS[$i]} ") "
        else
            out+="  $(dim "${TABS[$i]}")  "
        fi
    done
    printf '%s' "$out" >&3

    move_to 2 1
    clear_line
    dim "  tab/S-tab switch  j/k scroll  space toggle  enter confirm  esc close"
}

# Draw auto-yes tab
draw_auto_yes() {
    local current
    current=$(tmux show-option -pqvt "$PANE_ID" @clawtab-auto-yes)

    local row=4
    move_to $row 1; clear_line

    if [ "$current" = "1" ]; then
        printf '  Auto-yes: ' >&3
        green "ON"
    else
        printf '  Auto-yes: ' >&3
        dim "OFF"
    fi

    row=6
    move_to $row 1; clear_line
    printf '  ' >&3
    reverse_video " Enter "
    printf ' toggle auto-yes' >&3

    row=8
    move_to $row 1; clear_line
    dim "  When ON, permission prompts are automatically accepted."

    # Clear remaining lines
    for ((r=row+1; r<=LINES; r++)); do
        move_to $r 1; clear_line
    done
}

# Draw secrets tab
draw_secrets() {
    local count=${#SECRETS_LIST[@]}
    local row=4

    if [ $count -eq 0 ]; then
        move_to $row 1; clear_line
        if ! command -v cwtctl &>/dev/null; then
            dim "  cwtctl not found"
        else
            dim "  No secrets available"
        fi
        for ((r=row+1; r<=LINES; r++)); do
            move_to $r 1; clear_line
        done
        return
    fi

    local visible=$((LINES - 6))
    if [ $visible -lt 1 ]; then visible=1; fi

    # Adjust scroll to keep cursor visible
    if [ $CURSOR -lt $SCROLL ]; then
        SCROLL=$CURSOR
    elif [ $CURSOR -ge $((SCROLL + visible)) ]; then
        SCROLL=$((CURSOR - visible + 1))
    fi

    local idx mark sel_count status_row
    for ((i=0; i<visible; i++)); do
        idx=$((SCROLL + i))
        move_to $((row + i)) 1; clear_line
        if [ $idx -ge $count ]; then
            continue
        fi

        mark=" "
        if [ "${SECRET_SELECTED[$idx]}" = "1" ]; then
            mark="x"
        fi

        if [ $idx -eq $CURSOR ]; then
            printf '  ' >&3
            reverse_video "[$mark] ${SECRETS_LIST[$idx]}"
        else
            printf "  [$mark] ${SECRETS_LIST[$idx]}" >&3
        fi
    done

    # Status line
    sel_count=0
    for s in "${SECRET_SELECTED[@]}"; do
        [ "$s" = "1" ] && ((sel_count++))
    done

    status_row=$((LINES - 1))
    move_to $status_row 1; clear_line
    if [ $sel_count -gt 0 ]; then
        printf '  ' >&3
        green "$sel_count selected"
        printf ' - ' >&3
        bold "enter"
        printf ' to fork with secrets' >&3
    else
        dim "  space to select, enter to fork with selected"
    fi

    # Clear between list and status
    for ((r=row+visible; r<status_row; r++)); do
        move_to $r 1; clear_line
    done
}

# Draw skills tab
draw_skills() {
    local count=${#SKILLS_LIST[@]}
    local row=4

    if [ $count -eq 0 ]; then
        move_to $row 1; clear_line
        dim "  No skills found in ~/.claude/skills"
        for ((r=row+1; r<=LINES; r++)); do
            move_to $r 1; clear_line
        done
        return
    fi

    local visible=$((LINES - 6))
    if [ $visible -lt 1 ]; then visible=1; fi

    # Adjust scroll
    if [ $CURSOR -lt $SCROLL ]; then
        SCROLL=$CURSOR
    elif [ $CURSOR -ge $((SCROLL + visible)) ]; then
        SCROLL=$((CURSOR - visible + 1))
    fi

    local idx mark sel_count status_row
    for ((i=0; i<visible; i++)); do
        idx=$((SCROLL + i))
        move_to $((row + i)) 1; clear_line
        if [ $idx -ge $count ]; then
            continue
        fi

        mark=" "
        if [ "${SKILL_SELECTED[$idx]}" = "1" ]; then
            mark="x"
        fi

        if [ $idx -eq $CURSOR ]; then
            printf '  ' >&3
            reverse_video "[$mark] /${SKILLS_LIST[$idx]}"
        else
            printf "  [$mark] /${SKILLS_LIST[$idx]}" >&3
        fi
    done

    # Status line
    sel_count=0
    for s in "${SKILL_SELECTED[@]}"; do
        [ "$s" = "1" ] && ((sel_count++))
    done

    status_row=$((LINES - 1))
    move_to $status_row 1; clear_line
    if [ $sel_count -gt 0 ]; then
        printf '  ' >&3
        green "$sel_count selected"
        printf ' - ' >&3
        bold "enter"
        printf ' to send skills' >&3
    else
        dim "  space to select, enter to send selected"
    fi

    for ((r=row+visible; r<status_row; r++)); do
        move_to $r 1; clear_line
    done
}

# Get item count for current tab
tab_count() {
    case $TAB in
        0) echo 0 ;;
        1) echo ${#SECRETS_LIST[@]} ;;
        2) echo ${#SKILLS_LIST[@]} ;;
    esac
}

# Session resolution for secrets fork
resolve_session() {
    local comm
    pane_pid=$(tmux list-panes -t "$PANE_ID" -F '#{pane_id} #{pane_pid}' 2>/dev/null | grep "^${PANE_ID} " | cut -d' ' -f2)
    claude_pid=""
    for pid in $(pgrep -P "$pane_pid" 2>/dev/null); do
        comm=$(ps -o comm= -p "$pid" 2>/dev/null)
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

# Actions
do_enter() {
    local sel_count
    case $TAB in
        0)
            "$CURRENT_DIR/toggle-auto-yes.sh" "$PANE_ID"
            draw_auto_yes
            return 0
            ;;
        1)
            sel_count=0
            for s in "${SECRET_SELECTED[@]}"; do
                [ "$s" = "1" ] && ((sel_count++))
            done
            if [ $sel_count -eq 0 ]; then return 0; fi

            resolve_session
            if [ -z "$session_id" ]; then
                tmux display-message "Could not resolve conversation ID"
                return 1
            fi

            cat > "$META_FILE" << EOF
PANE_ID=$PANE_ID
SESSION_ID=$session_id
PANE_PATH=$pane_path
EOF
            for i in "${!SECRETS_LIST[@]}"; do
                if [ "${SECRET_SELECTED[$i]}" = "1" ]; then
                    echo "${SECRETS_LIST[$i]}" >> "$META_FILE"
                fi
            done

            tmux run-shell -b "$CURRENT_DIR/fork-with-secrets-exec.sh '$META_FILE'"
            META_FILE="/dev/null"
            return 1
            ;;
        2)
            sel_count=0
            for s in "${SKILL_SELECTED[@]}"; do
                [ "$s" = "1" ] && ((sel_count++))
            done
            if [ $sel_count -gt 0 ]; then
                for i in "${!SKILLS_LIST[@]}"; do
                    if [ "${SKILL_SELECTED[$i]}" = "1" ]; then
                        tmux send-keys -t "$PANE_ID" "/${SKILLS_LIST[$i]}" Enter
                    fi
                done
                return 1
            fi
            return 0
            ;;
    esac
}

do_space() {
    case $TAB in
        0)
            # Toggle auto-yes
            "$CURRENT_DIR/toggle-auto-yes.sh" "$PANE_ID"
            draw_auto_yes
            ;;
        1)
            # Toggle secret selection
            if [ ${#SECRETS_LIST[@]} -gt 0 ]; then
                if [ "${SECRET_SELECTED[$CURSOR]}" = "1" ]; then
                    SECRET_SELECTED[$CURSOR]=0
                else
                    SECRET_SELECTED[$CURSOR]=1
                fi
                if [ $CURSOR -lt $((${#SECRETS_LIST[@]} - 1)) ]; then
                    ((CURSOR++))
                fi
            fi
            ;;
        2)
            # Toggle skill selection
            if [ ${#SKILLS_LIST[@]} -gt 0 ]; then
                if [ "${SKILL_SELECTED[$CURSOR]}" = "1" ]; then
                    SKILL_SELECTED[$CURSOR]=0
                else
                    SKILL_SELECTED[$CURSOR]=1
                fi
                if [ $CURSOR -lt $((${#SKILLS_LIST[@]} - 1)) ]; then
                    ((CURSOR++))
                fi
            fi
            ;;
    esac
}

switch_tab() {
    local new_tab=$1
    if [ $new_tab -ne $TAB ]; then
        TAB=$new_tab
        CURSOR=0
        SCROLL=0
        # Clear content area to prevent bleed from previous tab
        get_size
        for ((r=4; r<=LINES; r++)); do
            move_to $r 1; clear_line
        done
    fi
}

# Main draw
draw() {
    get_size
    draw_tabs

    # Separator
    move_to 3 1; clear_line
    printf '  ' >&3
    for ((c=0; c<COLS-4; c++)); do printf '-' >&3; done

    case $TAB in
        0) draw_auto_yes ;;
        1) draw_secrets ;;
        2) draw_skills ;;
    esac
}

# Read a single keypress (handles escape sequences)
read_key() {
    IFS= read -rsn1 key
    case "$key" in
        "") echo "enter" ;;
        " ") echo "space" ;;
        $'\t') echo "next_tab" ;;
        $'\x1b')
            read -rsn1 -t 0.05 k2
            if [ -z "$k2" ]; then
                echo "esc"
                return
            fi
            read -rsn1 -t 0.05 k3
            case "$k3" in
                A) echo "up" ;;
                B) echo "down" ;;
                C) echo "right" ;;
                D) echo "left" ;;
                Z) echo "prev_tab" ;;  # Shift-Tab
                *) echo "unknown" ;;
            esac
            ;;
        "1") echo "tab1" ;;
        "2") echo "tab2" ;;
        "3") echo "tab3" ;;
        "j") echo "down" ;;
        "k") echo "up" ;;
        "q") echo "esc" ;;
        *) echo "unknown" ;;
    esac
}

# FD 3 = real terminal. All drawing goes through FD 3.
# Default stdout goes to /dev/null to suppress stray output.
exec 3>&1 1>/dev/null

# Hide cursor, enable alternate screen
tput civis 2>/dev/null >&3
printf '\033[?1049h' >&3
trap 'printf "\033[?1049l" >&3; tput cnorm 2>/dev/null >&3; rm -f "$META_FILE"' EXIT

# Initial draw
draw

# Event loop
max=0
while true; do
    local_key=$(read_key)
    case "$local_key" in
        esc)
            break
            ;;
        tab1) switch_tab 0; draw ;;
        tab2) switch_tab 1; draw ;;
        tab3) switch_tab 2; draw ;;
        next_tab|right)
            switch_tab $(( (TAB + 1) % 3 ))
            draw
            ;;
        prev_tab|left)
            switch_tab $(( (TAB + 2) % 3 ))
            draw
            ;;
        up)
            if [ $CURSOR -gt 0 ]; then
                ((CURSOR--))
                case $TAB in
                    1) draw_secrets ;;
                    2) draw_skills ;;
                esac
            fi
            ;;
        down)
            max=$(tab_count)
            if [ $max -gt 0 ] && [ $CURSOR -lt $((max - 1)) ]; then
                ((CURSOR++))
                case $TAB in
                    1) draw_secrets ;;
                    2) draw_skills ;;
                esac
            fi
            ;;
        space)
            do_space
            case $TAB in
                1) draw_secrets ;;
                2) draw_skills ;;
            esac
            ;;
        enter)
            if ! do_enter; then
                break
            fi
            ;;
    esac
done
