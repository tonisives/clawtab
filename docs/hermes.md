# Hermes integration

The integration targets Hermes Agent v0.22.4. ClawTab launches `hermes chat --cli` for prompt and folder jobs, with the selected model and `--reasoning` level. Existing classic CLI and node TUI sessions are detected in tmux. Models come from the active Hermes profile's configuration; custom model IDs can be added in ClawTab's model settings.

## Implementation plan and scope

1. Add Hermes to provider selection, launch commands, remote messages, model discovery and tmux labels.
2. Resolve the conversation displayed by each terminal, then read its metadata without modifying Hermes storage.
3. Install profile-scoped lifecycle hooks and map them to existing activity, notifications and auto-yes.
4. Adapt approval and clarification replies to both Hermes interfaces while retaining normal remote PTY control.
5. Validate with fixtures, frontend tests and real Hermes processes against a deterministic local model.

| Capability | Behavior |
| --- | --- |
| Session information | Conversation ID, title, model, start time, first/latest active human prompt, latest input time, input/output token total |
| Remote terminal | Existing authenticated remote transport carries input, output, keys, resizing and reconnects |
| Tmux | Detection, generated titles, popup information, working/waiting/idle state and auto-yes |
| Launch and scheduling | Prompt and folder jobs use the configured model, reasoning level and prompt file |
| Approvals | Current CLI/TUI numbered controls and plain CLI `/approve` prompts; one-time/session choices work with auto-yes |
| Clarification | Numbered choices and free-text answers; ordinary clarification choices are not auto-approved |
| Resume | Restore command pins the original Hermes profile and exact conversation ID |

Forking, skill injection, secret injection and provider quota reports are not advertised for Hermes. Complex multi-select, credentials and local confirmation dialogs remain controllable through the remote terminal. Native Windows Hermes metadata discovery is not implemented; the live validation described below runs on macOS with tmux. Linux has process/environment and tty discovery paths but was not exercised against a live Hermes installation in this change.

## Setup

Install and configure Hermes normally, then enable its integration in ClawTab's agent integration settings, or run:

```sh
cwt agent hooks install hermes
cwt agent hooks status hermes
```

The daemon resolves its `HERMES_HOME` and Hermes's sticky `active_profile`. Installation updates that profile's `config.yaml` and `shell-hooks-allowlist.json`, preserving other hook registrations and settings. Existing files receive `.clawtab-backup` backups. The YAML is reserialized, so comments and formatting remain in the backup. Only ClawTab's six exact hook commands are approved; the global hook auto-accept setting is preserved.

Restart that Hermes gateway after installation and reopen a session so its startup hook registrations reload. For multiple profiles, enable the hooks in each profile you want to monitor. A daemon started before an environment change retains its launch environment; setting `HERMES_HOME` on the `cwt` invocation alone does not change the daemon's selected profile.

For classic CLI metadata, leave Hermes's `session.terminal_continue` enabled. That setting writes the terminal identity breadcrumb used by ClawTab.

## Identity and event handling

Hermes uses a shared gateway. The gateway's inherited tmux pane and PID can belong to another conversation. ClawTab therefore matches hooks by canonical profile home plus session ID, then associates that identity with the visible terminal:

- Classic CLI: the terminal's fresh `terminal-sessions` breadcrumb, checked against the process start time.
- Node TUI: the process's `HERMES_TUI_ACTIVE_SESSION_FILE`, which changes when the view switches sessions.
- A changed sticky default: fresh tty breadcrumbs in the original root and sibling profiles preserve an already-running CLI's identity.

Directory proximity, newest sessions and titles are not identity signals. A newly created conversation can expose its ID before Hermes creates the database row; the remaining fields appear when Hermes persists them. Read-only SQLite queries exclude inactive generations, observations and compaction summaries from human prompt fields.

`on_session_start` means idle; `pre_llm_call` means working; `on_human_input_request` means waiting; `on_human_input_resolved` means working. `on_session_end` means the turn finished, including interrupted/error turns. Only `on_session_finalize` retires a session marker. Hook input is streamed into a minimal record; conversation history and tool arguments are not stored in ClawTab's hook spool.

Hermes treats Enter arriving within 50 ms of text as a pasted newline. Programmatic message submission waits 150 ms before Enter. Numbered choices submit immediately, without a second Enter that could answer the next question in a batch. Free-text controls use arrow navigation because the node TUI's “Other” choice has no numeric shortcut.

## Reproducible validation

Build the hook and opt-in test executable:

```sh
cargo build --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --bin clawtab-hook -j4
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features --lib --no-run -j4
```

Use the executable path printed by Cargo, then run both interfaces:

```sh
python3 tests/hermes-integration.py --hermes /path/to/hermes --hook /path/to/clawtab-hook --test-binary /path/to/clawtab_lib-test
python3 tests/hermes-integration.py --hermes /path/to/hermes --hook /path/to/clawtab-hook --test-binary /path/to/clawtab_lib-test --tui
```

For a venv source installation, add `--inline-launcher` to exercise the bundled Python `-c` entry-point shape. Discovery reads the actual argument boundaries for those launchers and excludes gateway/administrative invocations.

On the development Mac, run Cargo through the parent repository's `scripts/build-guard.py` when its target directory is on `/Volumes/sam`. A source Hermes installation needs its Python dependencies and built `ui-tui/dist/entry.js` for the second command.

The runner creates a private tmux socket, named profile, managed-session directory, hook spool and loopback model endpoint. It opens two real Hermes conversations in the same folder. The model issues only fixed test responses, one `printf` command behind a forced approval, and a color clarification. It uses no paid model or installed ClawTab daemon. Test processes are stopped afterward; failures retain terminal captures and local diagnostics.

The workflow checks distinct metadata and remote process snapshots, PTY input/output/resize, working/idle isolation, approvals, manual answers, auto-yes, clarification free text, stale-card removal, follow-up isolation, interruption, explicit `/new` confirmation, identity switching, reconnect, profile-pinned resume and pane cleanup. It exercises the daemon-side remote terminal backend; it does not replace an end-to-end test through a physical phone and production relay.

Fixtures also cover malformed/missing databases, stale breadcrumbs, identical IDs in different profiles, process argument parsing, changing defaults, hook installation/repair/removal, long hook payloads, prompt quoting and older-host model selection.

Validation on 2026-10-23: the headless Rust suite passed 238 tests; desktop Rust checking, the desktop frontend production build and remote TypeScript checking passed. The frontend suite passed 161 tests outside two files with existing failures reproduced on the unchanged base: `desktop-remote-connection.test.cjs` (connection assertions/timeouts) and `todo-regressions.test.cjs` (terminal-cache expectations and missing analytics mocks). Six automated tmux shell tests passed. Real Hermes CLI, node TUI and inline-launcher workflows passed, including one-shot title generation.

## Compatibility sources

- [Hermes v0.22.4 release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.4)
- [Terminal breadcrumbs](https://github.com/NousResearch/hermes-agent/blob/v0.22.4/hermes_cli/terminal_breadcrumbs.py)
- [TUI launch identity](https://github.com/NousResearch/hermes-agent/blob/v0.22.4/hermes_cli/main_tui_launch.py)
- [TUI session lifecycle](https://github.com/NousResearch/hermes-agent/blob/v0.22.4/ui-tui/src/app/useSessionLifecycle.ts)
- [Shell hook registration and approval](https://github.com/NousResearch/hermes-agent/blob/v0.22.4/agent/shell_hooks.py)
- [CLI input and modal controls](https://github.com/NousResearch/hermes-agent/blob/v0.22.4/hermes_cli/cli_tui_mixin.py)
- [TUI prompt controls](https://github.com/NousResearch/hermes-agent/blob/v0.22.4/ui-tui/src/components/prompts.tsx)
