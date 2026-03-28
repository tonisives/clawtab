#!/usr/bin/env bash
# ClawTab popup - lazygit-style TUI with box-drawing borders
# Tabs: 1=Home  2=Secrets  3=Skills
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
TABS=("Home" "Secrets" "Skills")
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

# --- Color palette (256-color, tmux-safe) ---
C_BORDER='\033[38;5;240m'
C_TAB_ACTIVE='\033[1;48;5;31m\033[38;5;255m'
C_TAB_INACTIVE='\033[38;5;245m'
C_SELECTED='\033[48;5;236m\033[1;38;5;48m'
C_NORMAL='\033[38;5;252m'
C_DIM='\033[38;5;242m'
C_STATUS='\033[38;5;245m'
C_SEARCH='\033[38;5;220m'
C_CHECK_ON='\033[38;5;48m'
C_HEADER='\033[1;38;5;75m'
C_RESET='\033[0m'

# --- Box drawing ---
BOX_TL='╭' BOX_TR='╮' BOX_BL='╰' BOX_BR='╯'
BOX_H='─' BOX_V='│' BOX_ML='├' BOX_MR='┤'

# --- Drawing helpers ---
move_to() { printf '\033[%d;%dH' "$1" "$2" >&3; }
clear_line() { printf '\033[2K' >&3; }

# Generate n horizontal box-drawing characters
hfill() {
    local n=$1 i
    for ((i=0; i<n; i++)); do printf '%s' "$BOX_H"; done
}


# Draw left border at start of content row
draw_row_start() {
    move_to "$1" 1
    clear_line
    printf "${C_BORDER}${BOX_V}${C_RESET} " >&3
}

# Draw right border at end of content row
draw_row_end() {
    move_to "$1" "$TERM_COLS"
    printf "${C_BORDER}${BOX_V}${C_RESET}" >&3
}

# Draw an empty bordered row
draw_empty_row() {
    local row=$1 pad=$((TERM_COLS - 2))
    move_to "$row" 1
    printf "\033[2K${C_BORDER}${BOX_V}${C_RESET}%${pad}s${C_BORDER}${BOX_V}${C_RESET}" "" >&3
}

# --- Tab bar (top border) ---
draw_tabs() {
    local label_len=1  # 1 for the dash after corner
    for i in 0 1 2; do
        if [ $i -gt 0 ]; then label_len=$((label_len + 3)); fi
        label_len=$((label_len + ${#TABS[$i]} + 2))
    done
    label_len=$((label_len + 1))  # trailing space before fill
    local fill=$((TERM_COLS - 2 - label_len))
    [ $fill -lt 0 ] && fill=0

    move_to 1 1
    clear_line
    printf "${C_BORDER}%s%s" "$BOX_TL" "$BOX_H" >&3
    for i in 0 1 2; do
        if [ $i -gt 0 ]; then
            printf "${C_BORDER} | " >&3
        fi
        if [ $i -eq $TAB ]; then
            printf "${C_TAB_ACTIVE} %s ${C_RESET}" "${TABS[$i]}" >&3
        else
            printf "${C_TAB_INACTIVE} %s ${C_RESET}" "${TABS[$i]}" >&3
        fi
    done
    printf "${C_BORDER} %s%s${C_RESET}" "$(hfill $fill)" "$BOX_TR" >&3
}

# --- Status bar (bottom border) ---
draw_status_bar() {
    local text_len=0
    move_to "$TERM_ROWS" 1
    clear_line
    printf "${C_BORDER}${BOX_BL}${BOX_H} " >&3
    case $TAB in
        0)
            # "tab switch  j/k scroll  enter run" = 33 visible chars
            printf "${C_DIM}tab${C_RESET}${C_STATUS} switch  ${C_DIM}j/k${C_RESET}${C_STATUS} scroll  ${C_DIM}enter${C_RESET}${C_STATUS} run${C_RESET}" >&3
            text_len=33
            ;;
        1|2)
            local sel_count=0
            if [ $TAB -eq 1 ]; then
                for s in "${SECRET_SELECTED[@]}"; do [ "$s" = "1" ] && ((sel_count++)); done
            else
                for s in "${SKILL_SELECTED[@]}"; do [ "$s" = "1" ] && ((sel_count++)); done
            fi
            if [ $sel_count -gt 0 ]; then
                local action="fork with secrets"
                [ $TAB -eq 2 ] && action="send skills"
                # "N selected - enter to ACTION"
                printf "${C_CHECK_ON}%d selected${C_RESET}${C_STATUS} - ${C_DIM}enter${C_RESET}${C_STATUS} to %s${C_RESET}" "$sel_count" "$action" >&3
                local num_str="$sel_count"
                # N + " selected - enter to " + action
                text_len=$((${#num_str} + 21 + ${#action}))
            else
                # "space select  / search  enter run" = 33 visible chars
                printf "${C_DIM}space${C_RESET}${C_STATUS} select  ${C_DIM}/${C_RESET}${C_STATUS} search  ${C_DIM}enter${C_RESET}${C_STATUS} run${C_RESET}" >&3
                text_len=33
            fi
            ;;
    esac
    # Total: ╰(1) + ─(1) + space(1) + text + space(1) + fill + ╯(1) = TERM_COLS
    local fill=$((TERM_COLS - 5 - text_len))
    [ $fill -lt 0 ] && fill=0
    printf "${C_BORDER} %s%s${C_RESET}" "$(hfill $fill)" "$BOX_BR" >&3
}

# Draw search bar for secrets/skills tabs (row 2)
draw_search_bar() {
    draw_row_start 2
    if [ $SEARCHING -eq 1 ]; then
        printf "${C_SEARCH}/${C_RESET} %s${C_DIM}|${C_RESET}" "$SEARCH" >&3
    elif [ -n "$SEARCH" ]; then
        printf "${C_DIM}/${C_RESET} %s" "$SEARCH" >&3
    else
        printf "${C_DIM}/ search...${C_RESET}" >&3
    fi
    draw_row_end 2
}

# Shortcuts tab items and cursor
SHORTCUT_CURSOR=0
SHORTCUT_ITEMS=("Toggle auto-yes" "Fork session")

# Session info (loaded once)
SESSION_FIRST_QUERY=""
SESSION_LAST_QUERY=""
SESSION_STARTED_AT=""
SESSION_RELATIVE_TIME=""
declare -a QUERY_LINES
QUERY_SCROLL=0

relative_time() {
    local epoch=$1
    local now
    now=$(date +%s)
    local diff=$((now - epoch))
    if [ $diff -lt 60 ]; then
        echo "just now"
    elif [ $diff -lt 3600 ]; then
        local m=$((diff / 60))
        [ $m -eq 1 ] && echo "1m ago" || echo "${m}m ago"
    elif [ $diff -lt 86400 ]; then
        local h=$((diff / 3600))
        [ $h -eq 1 ] && echo "1h ago" || echo "${h}h ago"
    elif [ $diff -lt 604800 ]; then
        local d=$((diff / 86400))
        [ $d -eq 1 ] && echo "1d ago" || echo "${d}d ago"
    else
        local w=$((diff / 604800))
        [ $w -eq 1 ] && echo "1w ago" || echo "${w}w ago"
    fi
}

load_session_info() {
    if command -v cwtctl &>/dev/null; then
        local raw
        raw=$(cwtctl pane-info "$PANE_ID" 2>/dev/null)
        if [ -n "$raw" ]; then
            SESSION_STARTED_AT=$(echo "$raw" | grep '^started_at=' | cut -d= -f2-)
            SESSION_FIRST_QUERY=$(echo "$raw" | grep '^first_query=' | cut -d= -f2-)
            SESSION_LAST_QUERY=$(echo "$raw" | grep '^last_query=' | cut -d= -f2-)
            local epoch
            epoch=$(echo "$raw" | grep '^started_epoch=' | cut -d= -f2-)
            if [ -n "$epoch" ]; then
                SESSION_RELATIVE_TIME=$(relative_time "$epoch")
            fi
        fi
    fi
}

# Word-wrap a text string into QUERY_LINES array for the current terminal width
# Usage: wrap_query_lines [text]  (defaults to SESSION_FIRST_QUERY)
wrap_query_lines() {
    QUERY_LINES=()
    local text="${1:-$SESSION_FIRST_QUERY}"
    [ -z "$text" ] && return
    local max_len=$((TERM_COLS - 8))
    [ $max_len -lt 10 ] && max_len=10
    local query="$text"
    while [ ${#query} -gt 0 ]; do
        if [ ${#query} -le $max_len ]; then
            QUERY_LINES+=("$query")
            break
        fi
        local chunk="${query:0:$max_len}"
        local break_at=$max_len
        local last_space="${chunk% *}"
        if [ ${#last_space} -gt 0 ] && [ ${#last_space} -lt ${#chunk} ]; then
            break_at=${#last_space}
        fi
        QUERY_LINES+=("${query:0:$break_at}")
        query="${query:$break_at}"
        query="${query# }"
    done
}
load_session_info

# Draw shortcuts (Home) tab
draw_shortcuts() {
    local current row

    row=2
    draw_empty_row $row

    row=3
    for ((i=0; i<${#SHORTCUT_ITEMS[@]}; i++)); do
        draw_row_start $row
        local label="${SHORTCUT_ITEMS[$i]}"
        local suffix=""

        # Key hint
        local hint=""
        if [ $i -eq 0 ]; then hint="y"; fi
        if [ $i -eq 1 ]; then hint="f"; fi

        if [ $i -eq $SHORTCUT_CURSOR ]; then
            printf "${C_SELECTED} > %s ${C_RESET}" "$label" >&3
        else
            printf "${C_NORMAL}   %s ${C_RESET}" "$label" >&3
        fi

        # Add status info
        if [ $i -eq 0 ]; then
            current=$(tmux show-option -pqvt "$PANE_ID" @clawtab-auto-yes)
            if [ "$current" = "1" ]; then
                printf " ${C_CHECK_ON}ON${C_RESET}" >&3
            else
                printf " ${C_DIM}OFF${C_RESET}" >&3
            fi
        fi
        if [ -n "$hint" ]; then
            printf "  ${C_DIM}(%s)${C_RESET}" "$hint" >&3
        fi
        draw_row_end $row
        ((row++))
    done

    draw_empty_row $row
    ((row++))

    # Session info
    if [ -n "$SESSION_STARTED_AT" ] || [ -n "$SESSION_FIRST_QUERY" ]; then
        local fill=$((TERM_COLS - 2 - 1 - 9 - 1))
        [ $fill -lt 0 ] && fill=0
        move_to $row 1; clear_line
        printf "${C_BORDER}${BOX_ML}${BOX_H}${C_HEADER} Session ${C_BORDER} %s${BOX_MR}${C_RESET}" "$(hfill $fill)" >&3
        ((row++))

        draw_empty_row $row
        ((row++))

        if [ -n "$SESSION_STARTED_AT" ]; then
            draw_row_start $row
            printf "${C_DIM}Started:${C_RESET} ${C_NORMAL}%s${C_RESET}" "$SESSION_STARTED_AT" >&3
            if [ -n "$SESSION_RELATIVE_TIME" ]; then
                printf "  ${C_DIM}(%s)${C_RESET}" "$SESSION_RELATIVE_TIME" >&3
            fi
            draw_row_end $row
            ((row++))
        fi

        if [ -n "$SESSION_FIRST_QUERY" ]; then
            draw_row_start $row
            printf "${C_DIM}First query:${C_RESET}" >&3
            draw_row_end $row
            ((row++))

            wrap_query_lines "$SESSION_FIRST_QUERY"
            for ((qi=0; qi<${#QUERY_LINES[@]}; qi++)); do
                if [ $row -ge $((TERM_ROWS - 1)) ]; then break; fi
                draw_row_start $row
                printf "${C_NORMAL}  %s${C_RESET}" "${QUERY_LINES[$qi]}" >&3
                draw_row_end $row
                ((row++))
            done
        fi

        if [ -n "$SESSION_LAST_QUERY" ]; then
            draw_empty_row $row
            ((row++))

            draw_row_start $row
            printf "${C_DIM}Latest query:${C_RESET}" >&3
            draw_row_end $row
            ((row++))

            wrap_query_lines "$SESSION_LAST_QUERY"
            local total_lines=${#QUERY_LINES[@]}
            local avail=$((TERM_ROWS - row - 1))
            [ $avail -lt 1 ] && avail=1

            if [ $QUERY_SCROLL -gt $((total_lines - avail)) ]; then
                QUERY_SCROLL=$((total_lines - avail))
            fi
            [ $QUERY_SCROLL -lt 0 ] && QUERY_SCROLL=0

            local shown=0
            if [ $QUERY_SCROLL -gt 0 ]; then
                draw_row_start $row
                printf "${C_DIM}  ... scroll up for more ...${C_RESET}" >&3
                draw_row_end $row
                ((row++))
                ((avail--))
            fi
            for ((qi=QUERY_SCROLL; qi<total_lines && shown<avail; qi++)); do
                draw_row_start $row
                printf "${C_NORMAL}  %s${C_RESET}" "${QUERY_LINES[$qi]}" >&3
                draw_row_end $row
                ((row++))
                ((shown++))
            done
            if [ $((QUERY_SCROLL + shown)) -lt $total_lines ]; then
                draw_row_start $row
                printf "${C_DIM}  ... scroll down for more ...${C_RESET}" >&3
                draw_row_end $row
                ((row++))
            fi
        fi
    fi

    for ((r=row; r<TERM_ROWS; r++)); do
        draw_empty_row $r
    done
}

# Draw a list tab (secrets or skills)
draw_list() {
    local tab_type=$1  # "secrets" or "skills"
    apply_filter
    local count=${#FILTERED_INDICES[@]}
    local list_start=4

    draw_search_bar
    # Mid-separator between search bar and list
    local sep_fill=$((TERM_COLS - 2))
    move_to 3 1; clear_line
    printf "${C_BORDER}%s%s%s${C_RESET}" "$BOX_ML" "$(hfill $sep_fill)" "$BOX_MR" >&3

    if [ $count -eq 0 ]; then
        draw_row_start $list_start
        if [ -n "$SEARCH" ]; then
            printf "${C_DIM}No matches${C_RESET}" >&3
        elif [ "$tab_type" = "secrets" ]; then
            if ! command -v cwtctl &>/dev/null; then
                printf "${C_DIM}cwtctl not found${C_RESET}" >&3
            else
                printf "${C_DIM}No secrets available${C_RESET}" >&3
            fi
        else
            printf "${C_DIM}No skills found in ~/.claude/skills${C_RESET}" >&3
        fi
        draw_row_end $list_start
        for ((r=list_start+1; r<TERM_ROWS; r++)); do
            draw_empty_row $r
        done
        return
    fi

    # List fills from list_start to TERM_ROWS-2 (last content row before bottom border)
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
        draw_row_start $((list_start + i))
        if [ $idx -ge $count ]; then
            draw_row_end $((list_start + i))
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
            if [ "$mark" = "x" ]; then
                printf "${C_SELECTED} > ${C_CHECK_ON}[%s]${C_RESET} ${C_SELECTED}%s${C_RESET}" "$mark" "$prefix" >&3
            else
                printf "${C_SELECTED} > ${C_DIM}[%s]${C_RESET} ${C_SELECTED}%s${C_RESET}" "$mark" "$prefix" >&3
            fi
        else
            if [ "$mark" = "x" ]; then
                printf "${C_NORMAL}   ${C_CHECK_ON}[%s]${C_RESET} ${C_NORMAL}%s${C_RESET}" "$mark" "$prefix" >&3
            else
                printf "${C_NORMAL}   ${C_DIM}[%s]${C_RESET} ${C_NORMAL}%s${C_RESET}" "$mark" "$prefix" >&3
            fi
        fi
        draw_row_end $((list_start + i))
    done

    # Scroll indicator row (only if there are hidden items)
    local next_row=$((list_start + visible))
    if [ $count -gt $visible ]; then
        draw_row_start $next_row
        if [ $SCROLL -gt 0 ] && [ $((SCROLL + visible)) -lt $count ]; then
            printf "${C_DIM}... more above and below ...${C_RESET}" >&3
        elif [ $SCROLL -gt 0 ]; then
            printf "${C_DIM}... more above ...${C_RESET}" >&3
        elif [ $((SCROLL + visible)) -lt $count ]; then
            printf "${C_DIM}... more below ...${C_RESET}" >&3
        fi
        draw_row_end $next_row
        ((next_row++))
    fi

    # Fill gap between list end and bottom border
    for ((r=next_row; r<TERM_ROWS; r++)); do
        draw_empty_row $r
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
                    draw_status_bar
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
                draw_status_bar
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
        QUERY_SCROLL=0
    fi
}

# Main draw
draw() {
    get_size
    draw_tabs

    case $TAB in
        0) draw_shortcuts ;;
        1) draw_secrets ;;
        2) draw_skills ;;
    esac

    draw_status_bar
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
                    1) draw_secrets; draw_status_bar ;;
                    2) draw_skills; draw_status_bar ;;
                esac
                ;;
            char:*)
                SEARCH+="${search_key#char:}"
                CURSOR=0
                SCROLL=0
                case $TAB in
                    1) draw_secrets; draw_status_bar ;;
                    2) draw_skills; draw_status_bar ;;
                esac
                ;;
            up)
                SEARCHING=0
                case $TAB in
                    1) draw_secrets; draw_status_bar ;;
                    2) draw_skills; draw_status_bar ;;
                esac
                ;;
            down)
                SEARCHING=0
                case $TAB in
                    1) draw_secrets; draw_status_bar ;;
                    2) draw_skills; draw_status_bar ;;
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
                    1) draw_secrets; draw_status_bar ;;
                    2) draw_skills; draw_status_bar ;;
                esac
            fi
            ;;
        up)
            if [ $TAB -eq 0 ]; then
                if [ $QUERY_SCROLL -gt 0 ]; then
                    ((QUERY_SCROLL--))
                elif [ $SHORTCUT_CURSOR -gt 0 ]; then
                    ((SHORTCUT_CURSOR--))
                fi
                draw_tabs; draw_shortcuts; draw_status_bar
            else
                max=$(tab_count)
                if [ $max -gt 0 ]; then
                    if [ $CURSOR -gt 0 ]; then
                        ((CURSOR--))
                    else
                        CURSOR=$((max - 1))
                    fi
                    case $TAB in
                        1) draw_secrets; draw_status_bar ;;
                        2) draw_skills; draw_status_bar ;;
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
                    # Scroll last query if there are more lines
                    wrap_query_lines "$SESSION_LAST_QUERY"
                    local q_total=${#QUERY_LINES[@]}
                    local q_avail=$((TERM_ROWS - 4 - ${#SHORTCUT_ITEMS[@]} - 6))
                    [ $q_avail -lt 1 ] && q_avail=1
                    if [ $((QUERY_SCROLL + q_avail)) -lt $q_total ]; then
                        ((QUERY_SCROLL++))
                    fi
                fi
                draw_tabs; draw_shortcuts; draw_status_bar
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
                        1) draw_secrets; draw_status_bar ;;
                        2) draw_skills; draw_status_bar ;;
                    esac
                fi
            fi
            ;;
        space)
            do_space
            case $TAB in
                1) draw_secrets; draw_status_bar ;;
                2) draw_skills; draw_status_bar ;;
            esac
            ;;
        enter)
            if ! do_enter; then
                break
            fi
            ;;
        shortcut_y)
            "$CURRENT_DIR/toggle-auto-yes.sh" "$PANE_ID"
            if [ $TAB -eq 0 ]; then draw_shortcuts; draw_status_bar; fi
            ;;
        shortcut_f)
            tmux send-keys -t "$PANE_ID" "forking" Enter Escape Escape
            sleep 0.3
            resolve_pane_path
            tmux split-window -v -t "$PANE_ID" -c "$pane_path" "claude --continue --fork-session"
            break
            ;;
        char:*)
            # Auto-search: typing on secrets/skills tabs enters search mode
            if [ $TAB -ne 0 ]; then
                SEARCHING=1
                SEARCH="${local_key#char:}"
                CURSOR=0
                SCROLL=0
                case $TAB in
                    1) draw_secrets; draw_status_bar ;;
                    2) draw_skills; draw_status_bar ;;
                esac
            fi
            ;;
    esac
done
