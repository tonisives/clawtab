#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POPUP_SCRIPT="$SCRIPT_DIR/../scripts/popup-menu.sh"
TEST_DIR="$(mktemp -d)"
ACTION_LOG="$TEST_DIR/action-args"
FZF_LOG="$TEST_DIR/fzf-options"
INPUT_FILE="$TEST_DIR/input"
LOAD_FUNCTIONS_FILE="$TEST_DIR/load-agent-actions.sh"
ACTION_FUNCTIONS_FILE="$TEST_DIR/agent-actions.sh"
trap 'rm -rf "$TEST_DIR"' EXIT

printf '%s\n\n' 'value with spaces; $(this must stay literal)' > "$INPUT_FILE"
sed -n '/^append_agent_action() {/,/^load_agent_actions$/p' "$POPUP_SCRIPT" | sed '$d' > "$LOAD_FUNCTIONS_FILE"
sed -n '/^select_agent_option() {/,/^# Actions$/p' "$POPUP_SCRIPT" | sed '$d' > "$ACTION_FUNCTIONS_FILE"

TEST_ACTIONS_JSON='{
  "actions": [
    {
      "id": "demo.generic",
      "title": "Generic action",
      "description": "Exercises every parameter kind",
      "available": true,
      "parameters": [
        {
          "name": "note",
          "title": "Note",
          "description": "A free-form note",
          "placeholder": "enter a note",
          "required": true,
          "kind": "string"
        },
        {
          "name": "enabled",
          "title": "Enabled",
          "required": true,
          "default_value": "false",
          "kind": "boolean"
        },
        {
          "name": "flavor",
          "title": "Flavor",
          "required": true,
          "default_value": "safe; mode",
          "kind": "choice",
          "options": ["safe; mode", "other"]
        },
        {
          "name": "model",
          "title": "Model",
          "required": true,
          "default_value": "model one",
          "kind": "model",
          "options": ["model one", "model two"]
        },
        {
          "name": "effort",
          "title": "Effort",
          "required": false,
          "default_value": "high",
          "kind": "effort",
          "options": ["low", "high"]
        }
      ]
    },
    {
      "id": "demo.disabled",
      "title": "Disabled action",
      "description": "Cannot run in this pane",
      "available": false,
      "unavailable_reason": "Not available in this pane",
      "parameters": []
    },
    {
      "id": "demo.instant",
      "title": "Instant action",
      "description": "Runs without parameters",
      "available": true,
      "parameters": []
    },
    {
      "id": "demo.required",
      "title": "Required action",
      "description": "Requires a value",
      "available": true,
      "parameters": [
        {
          "name": "required_text",
          "title": "Required text",
          "required": true,
          "kind": "string"
        }
      ]
    }
  ]
}'

(
    exec < "$INPUT_FILE"
    exec 3>/dev/null

    PANE_ID="%test"
    PLUGIN_ITEMS=()
    AGENT_ACTION_IDS=()
    AGENT_ACTION_AVAILABLE=()
    AGENT_ACTION_UNAVAILABLE_REASONS=()
    AGENT_ACTIONS_JSON=""
    C_HEADER="" C_RESET="" C_DIM="" C_SEARCH=""
    TMUX_MESSAGES=""

    cwtctl() {
        if [ "${1:-}" = "agent" ] && [ "${2:-}" = "actions" ]; then
            printf '%s' "$TEST_ACTIONS_JSON"
        elif [ "${1:-}" = "agent" ] && [ "${2:-}" = "action" ] && [ "${3:-}" = "run" ]; then
            printf '%s\n' "$@" >> "$ACTION_LOG"
        fi
    }

    fzf() {
        local first="" option
        IFS= read -r first || return 1
        printf '%s\n' "$first" >> "$FZF_LOG"
        while IFS= read -r option; do
            printf '%s\n' "$option" >> "$FZF_LOG"
        done
        printf '%s' "$first"
    }

    tmux() {
        if [ "${1:-}" = "display-message" ]; then
            TMUX_MESSAGES+="${2:-}"$'\n'
        fi
    }

    draw() { :; }

    source "$LOAD_FUNCTIONS_FILE"
    source "$ACTION_FUNCTIONS_FILE"

    load_agent_actions
    [ "${#PLUGIN_ITEMS[@]}" -eq 4 ] || {
        printf 'expected four plugin actions, got %s\n' "${#PLUGIN_ITEMS[@]}" >&2
        exit 1
    }
    [ "${PLUGIN_ITEMS[1]}" = 'Agent: Disabled action [disabled: Not available in this pane]' ] || {
        printf 'disabled action was not rendered with its reason\n' >&2
        exit 1
    }
    [ "${AGENT_ACTION_AVAILABLE[1]}" = "false" ] || {
        printf 'disabled action was marked available\n' >&2
        exit 1
    }

    : > "$ACTION_LOG"
    disabled_status=0
    if run_agent_action_from_menu "demo.disabled"; then disabled_status=$?; else disabled_status=$?; fi
    [ "$disabled_status" -eq 0 ] || {
        printf 'disabled action returned status %s\n' "$disabled_status" >&2
        exit 1
    }
    [ ! -s "$ACTION_LOG" ] || {
        printf 'disabled action was executed\n' >&2
        exit 1
    }

    instant_status=0
    if run_agent_action_from_menu "demo.instant"; then instant_status=$?; else instant_status=$?; fi
    [ "$instant_status" -eq 1 ] || {
        printf 'no-parameter action returned status %s\n' "$instant_status" >&2
        exit 1
    }
    instant_args="$(<"$ACTION_LOG")"
    [ "$instant_args" = $'agent\naction\nrun\ndemo.instant\n%test' ] || {
        printf 'no-parameter action arguments were incorrect\n' >&2
        exit 1
    }

    : > "$ACTION_LOG"
    generic_status=0
    if run_agent_action_from_menu "demo.generic"; then generic_status=$?; else generic_status=$?; fi
    [ "$generic_status" -eq 1 ] || {
        printf 'generic action returned status %s\n' "$generic_status" >&2
        exit 1
    }
    generic_args="$(<"$ACTION_LOG")"
    expected_generic_args=$'agent\naction\nrun\ndemo.generic\n%test\nnote=value with spaces; $(this must stay literal)\nenabled=false\nflavor=safe; mode\nmodel=model one\neffort=high'
    [ "$generic_args" = "$expected_generic_args" ] || {
        printf 'generic action arguments were incorrect\n' >&2
        exit 1
    }
    grep -q '^true$' "$FZF_LOG" || {
        printf 'boolean picker did not offer true\n' >&2
        exit 1
    }
    grep -q '^false$' "$FZF_LOG" || {
        printf 'boolean picker did not offer false\n' >&2
        exit 1
    }

    required_status=0
    if run_agent_action_from_menu "demo.required"; then required_status=$?; else required_status=$?; fi
    [ "$required_status" -eq 0 ] || {
        printf 'missing required value returned status %s\n' "$required_status" >&2
        exit 1
    }
    [ "$(<"$ACTION_LOG")" = "$expected_generic_args" ] || {
        printf 'action ran after a missing required value\n' >&2
        exit 1
    }
    [[ "$TMUX_MESSAGES" == *"ClawTab: required action parameter is missing"* ]] || {
        printf 'missing required value did not show the expected error\n' >&2
        exit 1
    }
)

printf 'popup agent action tests passed\n'
