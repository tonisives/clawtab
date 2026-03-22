#!/usr/bin/env bash
# Unified ClawTab popup - lazygit-style TUI
# Tabs: 1=Shortcuts  2=Secrets  3=Skills
# Navigation: tab/S-tab switch tabs, j/k or up/down scroll, / to search
# Actions: enter to select, space to toggle, esc to close

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

# Verify it's a Claude Code pane (semver = running, claude = starting up)
cmd=$(tmux list-panes -t "$PANE_ID" -F '#{pane_id} #{pane_current_command}' 2>/dev/null | grep "^${PANE_ID} " | cut -d' ' -f2)
if ! echo "$cmd" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' && ! echo "$cmd" | grep -qi 'claude'; then
    echo "Not a Claude Code pane (got: $cmd)"
    sleep 2
    exit 0
fi

META_FILE=$(mktemp /tmp/clawtab-meta-XXXXXX)
trap 'rm -f "$META_FILE"' EXIT

# State
TAB=0
TABS=("Shortcuts" "Secrets" "Skills")
CURSOR=0
SCROLL=0
SEARCH=""
SEARCHING=0

# Terminal dimensions (avoid LINES/COLUMNS - bash reserves those)
TERM_ROWS=24
TERM_COLS=60

# Multi-select tracking (indices)
declare -a SECRET_SELECTED
declare -a SKILL_SELECTED

# Data arrays
declare -a SKILLS_LIST
declare -a SECRETS_LIST

# Filtered indices (populated by apply_filter)
declare -a FILTERED_INDICES

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

# Apply search filter - populates FILTERED_INDICES
apply_filter() {
    FILTERED_INDICES=()
    local count item lower_search lower_item
    case $TAB in
        1) count=${#SECRETS_LIST[@]} ;;
        2) count=${#SKILLS_LIST[@]} ;;
        *) return ;;
    esac

    lower_search=$(printf '%s' "$SEARCH" | tr '[:upper:]' '[:lower:]')

    for ((i=0; i<count; i++)); do
        if [ $TAB -eq 1 ]; then
            item="${SECRETS_LIST[$i]}"
        else
            item="${SKILLS_LIST[$i]}"
        fi
        if [ -z "$SEARCH" ]; then
            FILTERED_INDICES+=($i)
        else
            lower_item=$(printf '%s' "$item" | tr '[:upper:]' '[:lower:]')
            if [[ "$lower_item" == *"$lower_search"* ]]; then
                FILTERED_INDICES+=($i)
            fi
        fi
    done
}

# Terminal size
get_size() {
    local sz
    sz=$(stty size 2>/dev/null)
    if [ -n "$sz" ]; then
        TERM_ROWS=${sz%% *}
        TERM_COLS=${sz##* }
    else
        TERM_ROWS=$(tput lines 2>/dev/null || echo 24)
        TERM_COLS=$(tput cols 2>/dev/null || echo 60)
    fi
}

# Drawing helpers
move_to() { printf '\033[%d;%dH' "$1" "$2" >&3; }
clear_line() { printf '\033[2K' >&3; }
bold() { printf '\033[1m%s\033[0m' "$1" >&3; }
dim() { printf '\033[2m%s\033[0m' "$1" >&3; }
green() { printf '\033[32m%s\033[0m' "$1" >&3; }

# Draw the tab bar with pill-style tabs
draw_tabs() {
    move_to 1 1
    clear_line
    printf '  ' >&3
    for i in 0 1 2; do
        if [ $i -eq $TAB ]; then
            printf '\033[1;7m %s \033[0m' "${TABS[$i]}" >&3
        else
            printf '\033[2m %s \033[0m' "${TABS[$i]}" >&3
        fi
        if [ $i -lt 2 ]; then
            printf '\033[2m|\033[0m' >&3
        fi
    done

    move_to 2 1
    clear_line
    dim "  tab switch  j/k scroll  space toggle  / search  enter run"
}

# Draw search bar for secrets/skills tabs
draw_search_bar() {
    move_to 4 1; clear_line
    if [ $SEARCHING -eq 1 ]; then
        printf '\033[1m  / \033[0m' >&3
        printf '%s' "$SEARCH" >&3
        printf '\033[2m|\033[0m' >&3
    elif [ -n "$SEARCH" ]; then
        printf '\033[2m  / \033[0m' >&3
        printf '%s' "$SEARCH" >&3
    else
        printf '\033[2m  / search...\033[0m' >&3
    fi
}

# Shortcuts tab items and cursor
SHORTCUT_CURSOR=0
SHORTCUT_ITEMS=("Toggle auto-yes" "Fork session")

# Draw shortcuts tab
draw_shortcuts() {
    local current row

    row=4
    for ((i=0; i<${#SHORTCUT_ITEMS[@]}; i++)); do
        move_to $row 1; clear_line
        local label="${SHORTCUT_ITEMS[$i]}"
        local suffix=""

        # Add status info
        if [ $i -eq 0 ]; then
            current=$(tmux show-option -pqvt "$PANE_ID" @clawtab-auto-yes)
            if [ "$current" = "1" ]; then
                suffix="  $(printf '\033[32mON\033[0m')"
            else
                suffix="  $(printf '\033[2mOFF\033[0m')"
            fi
        fi

        # Key hint
        local hint=""
        if [ $i -eq 0 ]; then hint="y"; fi
        if [ $i -eq 1 ]; then hint="f"; fi

        if [ $i -eq $SHORTCUT_CURSOR ]; then
            printf '  \033[7m %s \033[0m%s' "$label" "$suffix" >&3
        else
            printf '   %s %s' "$label" "$suffix" >&3
        fi
        if [ -n "$hint" ]; then
            printf '  \033[2m(%s)\033[0m' "$hint" >&3
        fi
        ((row++))
    done

    row=$((4 + ${#SHORTCUT_ITEMS[@]} + 1))
    move_to $row 1; clear_line
    dim "  enter to run"

    for ((r=row+1; r<=TERM_ROWS; r++)); do
        move_to $r 1; clear_line
    done
}

# Draw a list tab (secrets or skills)
draw_list() {
    local tab_type=$1  # "secrets" or "skills"
    apply_filter
    local count=${#FILTERED_INDICES[@]}
    local list_start=5

    draw_search_bar

    if [ $count -eq 0 ]; then
        move_to $list_start 1; clear_line
        if [ -n "$SEARCH" ]; then
            dim "  No matches"
        elif [ "$tab_type" = "secrets" ]; then
            if ! command -v cwtctl &>/dev/null; then
                dim "  cwtctl not found"
            else
                dim "  No secrets available"
            fi
        else
            dim "  No skills found in ~/.claude/skills"
        fi
        for ((r=list_start+1; r<=TERM_ROWS; r++)); do
            move_to $r 1; clear_line
        done
        return
    fi

    # List fills from list_start to TERM_ROWS-1 (last row = status)
    local visible=$((TERM_ROWS - list_start - 1))
    # Reserve 1 row for scroll indicator if items overflow
    if [ $count -gt $visible ]; then
        visible=$((visible - 1))
    fi
    if [ $visible -lt 1 ]; then visible=1; fi

    # Clamp cursor
    if [ $CURSOR -ge $count ]; then CURSOR=$((count - 1)); fi
    if [ $CURSOR -lt 0 ]; then CURSOR=0; fi

    # Adjust scroll
    if [ $CURSOR -lt $SCROLL ]; then
        SCROLL=$CURSOR
    elif [ $CURSOR -ge $((SCROLL + visible)) ]; then
        SCROLL=$((CURSOR - visible + 1))
    fi

    local idx real_idx mark prefix
    for ((i=0; i<visible; i++)); do
        idx=$((SCROLL + i))
        move_to $((list_start + i)) 1; clear_line
        if [ $idx -ge $count ]; then
            continue
        fi

        real_idx=${FILTERED_INDICES[$idx]}
        mark=" "

        if [ "$tab_type" = "secrets" ]; then
            [ "${SECRET_SELECTED[$real_idx]}" = "1" ] && mark="x"
            prefix="${SECRETS_LIST[$real_idx]}"
        else
            [ "${SKILL_SELECTED[$real_idx]}" = "1" ] && mark="x"
            prefix="/${SKILLS_LIST[$real_idx]}"
        fi

        if [ $idx -eq $CURSOR ]; then
            printf '  \033[7m[%s] %s\033[0m' "$mark" "$prefix" >&3
        else
            printf '  [%s] %s' "$mark" "$prefix" >&3
        fi
    done

    # Scroll indicator row (only if there are hidden items)
    local next_row=$((list_start + visible))
    if [ $count -gt $visible ]; then
        move_to $next_row 1; clear_line
        if [ $SCROLL -gt 0 ] && [ $((SCROLL + visible)) -lt $count ]; then
            dim "  ... more above and below ..."
        elif [ $SCROLL -gt 0 ]; then
            dim "  ... more above ..."
        elif [ $((SCROLL + visible)) -lt $count ]; then
            dim "  ... more below ..."
        fi
        ((next_row++))
    fi

    # Status line at bottom
    local status_row=$TERM_ROWS
    move_to $status_row 1; clear_line

    local sel_count=0
    if [ "$tab_type" = "secrets" ]; then
        for s in "${SECRET_SELECTED[@]}"; do [ "$s" = "1" ] && ((sel_count++)); done
        if [ $sel_count -gt 0 ]; then
            printf '  ' >&3; green "$sel_count selected"
            printf ' - ' >&3; bold "enter"; printf ' to fork with secrets' >&3
        else
            dim "  space to select, enter to fork with selected"
        fi
    else
        for s in "${SKILL_SELECTED[@]}"; do [ "$s" = "1" ] && ((sel_count++)); done
        if [ $sel_count -gt 0 ]; then
            printf '  ' >&3; green "$sel_count selected"
            printf ' - ' >&3; bold "enter"; printf ' to send skills' >&3
        else
            dim "  space to select, enter to send selected"
        fi
    fi

    # Clear gap between list end and status
    for ((r=next_row; r<status_row; r++)); do
        move_to $r 1; clear_line
    done
}

draw_secrets() { draw_list "secrets"; }
draw_skills() { draw_list "skills"; }

# Get filtered item count for current tab
tab_count() {
    case $TAB in
        0) echo 0 ;;
        1|2) apply_filter; echo ${#FILTERED_INDICES[@]} ;;
    esac
}

# Resolve pane working directory
resolve_pane_path() {
    pane_path=$(tmux list-panes -t "$PANE_ID" -F '#{pane_id} #{pane_current_path}' 2>/dev/null | grep "^${PANE_ID} " | cut -d' ' -f2-)
}

# Actions
do_enter() {
    local sel_count secret_count
    case $TAB in
        0)
            case $SHORTCUT_CURSOR in
                0)
                    "$CURRENT_DIR/toggle-auto-yes.sh" "$PANE_ID"
                    draw_shortcuts
                    return 0
                    ;;
                1)
                    # Fork session
                    tmux send-keys -t "$PANE_ID" "forking" Enter Escape Escape
                    sleep 0.3
                    resolve_pane_path
                    tmux split-window -v -t "$PANE_ID" -c "$pane_path" "claude --continue --fork-session"
                    return 1
                    ;;
            esac
            return 0
            ;;
        1|2)
            # Count selected secrets and skills
            sel_count=0
            for s in "${SKILL_SELECTED[@]}"; do [ "$s" = "1" ] && ((sel_count++)); done

            secret_count=0
            for s in "${SECRET_SELECTED[@]}"; do [ "$s" = "1" ] && ((secret_count++)); done

            # Auto-select single filtered result if nothing is selected
            apply_filter
            if [ $sel_count -eq 0 ] && [ $secret_count -eq 0 ] && [ ${#FILTERED_INDICES[@]} -eq 1 ]; then
                local auto_idx=${FILTERED_INDICES[0]}
                if [ $TAB -eq 2 ]; then
                    SKILL_SELECTED[$auto_idx]=1
                    sel_count=1
                elif [ $TAB -eq 1 ]; then
                    SECRET_SELECTED[$auto_idx]=1
                    secret_count=1
                fi
            fi

            # If nothing selected, do nothing
            if [ $sel_count -eq 0 ] && [ $secret_count -eq 0 ]; then return 0; fi

            # Send selected skills (without Enter - let user confirm)
            if [ $sel_count -gt 0 ]; then
                local first_skill=1
                for i in "${!SKILLS_LIST[@]}"; do
                    if [ "${SKILL_SELECTED[$i]}" = "1" ]; then
                        if [ $first_skill -eq 0 ]; then
                            tmux send-keys -t "$PANE_ID" " "
                        fi
                        tmux send-keys -t "$PANE_ID" "/${SKILLS_LIST[$i]}"
                        first_skill=0
                    fi
                done
            fi

            # Fork with selected secrets
            if [ $secret_count -gt 0 ]; then
                resolve_pane_path

                cat > "$META_FILE" << EOF
PANE_ID=$PANE_ID
PANE_PATH=$pane_path
EOF
                for i in "${!SECRETS_LIST[@]}"; do
                    if [ "${SECRET_SELECTED[$i]}" = "1" ]; then
                        echo "${SECRETS_LIST[$i]}" >> "$META_FILE"
                    fi
                done

                # Touch the JSONL by sending "forking" + ESC ESC to make this the most recent session
                tmux send-keys -t "$PANE_ID" "forking" Enter Escape Escape
                sleep 0.3

                tmux run-shell -b "$CURRENT_DIR/fork-with-secrets-exec.sh '$META_FILE'"
                META_FILE="/dev/null"
            fi

            return 1
            ;;
    esac
}

do_space() {
    case $TAB in
        0)
            if [ $SHORTCUT_CURSOR -eq 0 ]; then
                "$CURRENT_DIR/toggle-auto-yes.sh" "$PANE_ID"
                draw_shortcuts
            fi
            ;;
        1)
            apply_filter
            if [ ${#FILTERED_INDICES[@]} -gt 0 ]; then
                real_idx=${FILTERED_INDICES[$CURSOR]}
                if [ "${SECRET_SELECTED[$real_idx]}" = "1" ]; then
                    SECRET_SELECTED[$real_idx]=0
                else
                    SECRET_SELECTED[$real_idx]=1
                fi
                if [ $CURSOR -lt $((${#FILTERED_INDICES[@]} - 1)) ]; then
                    ((CURSOR++))
                fi
            fi
            ;;
        2)
            apply_filter
            if [ ${#FILTERED_INDICES[@]} -gt 0 ]; then
                real_idx=${FILTERED_INDICES[$CURSOR]}
                if [ "${SKILL_SELECTED[$real_idx]}" = "1" ]; then
                    SKILL_SELECTED[$real_idx]=0
                else
                    SKILL_SELECTED[$real_idx]=1
                fi
                if [ $CURSOR -lt $((${#FILTERED_INDICES[@]} - 1)) ]; then
                    ((CURSOR++))
                fi
            fi
            ;;
    esac
}

switch_tab() {
    new_tab=$1
    if [ $new_tab -ne $TAB ]; then
        TAB=$new_tab
        CURSOR=0
        SCROLL=0
        SEARCH=""
        SEARCHING=0
        get_size
        for ((r=3; r<=TERM_ROWS; r++)); do
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
    for ((c=0; c<TERM_COLS-4; c++)); do printf '\033[2m-\033[0m' >&3; done

    case $TAB in
        0) draw_shortcuts ;;
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
                Z) echo "prev_tab" ;;
                *) echo "unknown" ;;
            esac
            ;;
        "j") echo "down" ;;
        "k") echo "up" ;;
        "q") echo "esc" ;;
        "y") echo "shortcut_y" ;;
        "f") echo "shortcut_f" ;;
        "/") echo "search" ;;
        $'\x7f') echo "backspace" ;;
        *) echo "char:$key" ;;
    esac
}

# Read a keypress while in search mode
read_search_key() {
    IFS= read -rsn1 key
    case "$key" in
        "") echo "enter" ;;
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
                Z) echo "prev_tab" ;;
                *) echo "unknown" ;;
            esac
            ;;
        $'\x7f') echo "backspace" ;;
        *) echo "char:$key" ;;
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
    if [ $SEARCHING -eq 1 ]; then
        search_key=$(read_search_key)
        case "$search_key" in
            esc)
                SEARCHING=0
                SEARCH=""
                CURSOR=0
                SCROLL=0
                draw
                ;;
            enter)
                SEARCHING=0
                CURSOR=0
                SCROLL=0
                draw
                ;;
            backspace)
                if [ -n "$SEARCH" ]; then
                    SEARCH="${SEARCH%?}"
                    CURSOR=0
                    SCROLL=0
                fi
                case $TAB in
                    1) draw_secrets ;;
                    2) draw_skills ;;
                esac
                ;;
            char:*)
                SEARCH+="${search_key#char:}"
                CURSOR=0
                SCROLL=0
                case $TAB in
                    1) draw_secrets ;;
                    2) draw_skills ;;
                esac
                ;;
            up)
                SEARCHING=0
                case $TAB in
                    1) draw_secrets ;;
                    2) draw_skills ;;
                esac
                ;;
            down)
                SEARCHING=0
                case $TAB in
                    1) draw_secrets ;;
                    2) draw_skills ;;
                esac
                ;;
            next_tab)
                SEARCHING=0
                SEARCH=""
                switch_tab $(( (TAB + 1) % 3 ))
                draw
                ;;
            prev_tab)
                SEARCHING=0
                SEARCH=""
                switch_tab $(( (TAB + 2) % 3 ))
                draw
                ;;
        esac
        continue
    fi

    local_key=$(read_key)
    case "$local_key" in
        esc)
            break
            ;;
        tab1) switch_tab 0; draw ;;
        tab2) switch_tab 1; draw ;;
        tab3) switch_tab 2; draw ;;
        next_tab)
            switch_tab $(( (TAB + 1) % 3 ))
            draw
            ;;
        prev_tab)
            switch_tab $(( (TAB + 2) % 3 ))
            draw
            ;;
        search)
            if [ $TAB -ne 0 ]; then
                SEARCHING=1
                SEARCH=""
                CURSOR=0
                SCROLL=0
                case $TAB in
                    1) draw_secrets ;;
                    2) draw_skills ;;
                esac
            fi
            ;;
        up)
            if [ $TAB -eq 0 ]; then
                max=${#SHORTCUT_ITEMS[@]}
                if [ $SHORTCUT_CURSOR -gt 0 ]; then
                    ((SHORTCUT_CURSOR--))
                else
                    SHORTCUT_CURSOR=$((max - 1))
                fi
                draw_shortcuts
            else
                max=$(tab_count)
                if [ $max -gt 0 ]; then
                    if [ $CURSOR -gt 0 ]; then
                        ((CURSOR--))
                    else
                        CURSOR=$((max - 1))
                    fi
                    case $TAB in
                        1) draw_secrets ;;
                        2) draw_skills ;;
                    esac
                fi
            fi
            ;;
        down)
            if [ $TAB -eq 0 ]; then
                max=${#SHORTCUT_ITEMS[@]}
                if [ $SHORTCUT_CURSOR -lt $((max - 1)) ]; then
                    ((SHORTCUT_CURSOR++))
                else
                    SHORTCUT_CURSOR=0
                fi
                draw_shortcuts
            else
                max=$(tab_count)
                if [ $max -gt 0 ]; then
                    if [ $CURSOR -lt $((max - 1)) ]; then
                        ((CURSOR++))
                    else
                        CURSOR=0
                        SCROLL=0
                    fi
                    case $TAB in
                        1) draw_secrets ;;
                        2) draw_skills ;;
                    esac
                fi
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
        shortcut_y)
            "$CURRENT_DIR/toggle-auto-yes.sh" "$PANE_ID"
            if [ $TAB -eq 0 ]; then draw_shortcuts; fi
            ;;
        shortcut_f)
            tmux send-keys -t "$PANE_ID" "forking" Enter Escape Escape
            sleep 0.3
            resolve_pane_path
            tmux split-window -v -t "$PANE_ID" -c "$pane_path" "claude --continue --fork-session"
            break
            ;;
    esac
done
