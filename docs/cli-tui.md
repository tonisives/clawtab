# CLI & TUI

`cwtctl` and `cwttui` communicate over Unix domain sockets. There are two separate sockets, served by two separate processes:

- `/tmp/clawtab.sock` -- daemon. Background lifecycle: jobs, scheduling, relay, auto-yes. Always running once installed (`cwtctl daemon install`).
- `/tmp/clawtab-desktop.sock` -- desktop app. UI actions: focus a pane, open a tmux pane in the GUI. Only available when the desktop window is running.

`cwtctl` selects the right socket per command. The wire format is the same on both: newline-delimited JSON.

## CLI: cwtctl

```
cwtctl <command> [args]
```

### Commands requiring daemon

| Command | Description |
|---------|-------------|
| `jobs list` / `jobs ls` | List all jobs grouped by group |
| `jobs run <group>/<job>` | Run a job and follow its output |
| `jobs pause <group>/<job>` | Pause a running job |
| `jobs resume <group>/<job>` | Resume a paused job |
| `jobs restart <group>/<job>` | Restart a completed/failed job |
| `jobs status` | Show all job statuses as JSON |
| `usage <provider>` | Show local quota usage for `claude`, `codex`, `antigravity`, or `zai` |
| `auto-yes` | Show panes with auto-yes enabled |
| `auto-yes toggle [pane_id]` | Toggle auto-yes for a pane |
| `auto-yes check [pane_id]` | Check auto-yes (exit 0=on, 1=off) |
| `pane-info [pane_id]` | First query / session date for a Claude pane |
| `secrets` / `secrets get <k>...` | Secret access |
| `telegram send <message>` | Send a Telegram message |

### Daemon lifecycle commands

| Command | Description |
|---------|-------------|
| `daemon ping` | Check if the daemon is running |
| `daemon install` | Install and start the launchd service |
| `daemon stop` | Stop the daemon while keeping the launchd service installed |
| `daemon uninstall` | Stop and remove the launchd service |
| `daemon status` | Show whether the daemon is installed and running |
| `daemon restart` | Restart the daemon |
| `daemon logs` | Show recent daemon logs |

### Pane commands (require desktop app)

| Command | Description |
|---------|-------------|
| `open [pane_id]` | Open a tmux pane in the ClawTab GUI |
| `pane focus <left\|right\|up\|down>` | Move focus between ClawTab panes |

`pane focus` is intended to be called from `tmux.conf` and vim/nvim configs to share `Ctrl-h/j/k/l` navigation between vim windows, tmux panes, and ClawTab panes. See [Vim / Tmux Navigation](./vim-tmux-navigation.md).

Exit codes: `0` on success, `1` on error (with message on stderr).

## TUI: cwttui `beta`

Full-screen terminal UI built with [ratatui](https://ratatui.rs/).

```bash
cwttui
```

If ClawTab is not running, the TUI exits with an error message.

### Layout

```
┌─ ClawTab ──────────────────────┐
│ > -- daily-backup               │
│   >> deploy-staging             │
│   ok review-prs                 │
│   !! failed-job                 │
│   || paused-job                 │
├─ Status ────────────────────────┤
│ Started: deploy-staging         │
├─────────────────────────────────┤
│ q:quit r:run p:pause u:resume   │
│ R:restart s:refresh S:settings  │
│ o:tmux j/k:nav                  │
└─────────────────────────────────┘
```

### Status Indicators

| Icon | Meaning |
|------|---------|
| `--` | Idle |
| `>>` | Running |
| `ok` | Last run succeeded |
| `!!` | Last run failed |
| `\|\|` | Paused |

### Keybindings

| Key | Action |
|-----|--------|
| `j` / `Down` | Next job |
| `k` / `Up` | Previous job |
| `r` | Run selected job |
| `p` | Pause selected job |
| `u` | Resume selected job |
| `R` | Restart selected job |
| `s` | Force refresh data |
| `S` | Open GUI settings |
| `o` | Focus job's tmux window |
| `q` / `Esc` | Quit |

Auto-refreshes every 5 seconds.

## IPC Protocol

Both sockets use the same wire format: newline-delimited JSON, single request/response per line.

### Daemon socket -- `/tmp/clawtab.sock`

Commands (`IpcCommand` variants):

```json
"Ping"
{"ListJobs": null}
{"RunJob": {"name": "daily-backup"}}
{"PauseJob": {"name": "daily-backup"}}
{"ResumeJob": {"name": "daily-backup"}}
{"RestartJob": {"name": "daily-backup"}}
"GetStatus"
"GetAgentActivity"
"OpenSettings"
{"ToggleAutoYes": {"pane_id": "%12"}}
```

Responses (`IpcResponse` variants):

```json
"Pong"
"Ok"
{"Jobs": ["daily-backup", "deploy"]}
{"Status": {"daily-backup": {"state": "idle"}}}
{"AgentActivity": [{"pane_id": "%12", "working": true, "asking": false}]}
{"Error": "Job not found"}
```

Raw usage:

```bash
echo '"Ping"' | nc -U /tmp/clawtab.sock
```

### Desktop socket -- `/tmp/clawtab-desktop.sock`

Commands (`DesktopIpcCommand` variants):

```json
{"FocusPane": {"direction": "left"}}
{"OpenPane": {"pane_id": "%12"}}
```

Direction is one of `left`, `right`, `up`, `down`.

Responses share `IpcResponse`; the desktop handler only ever returns `"Ok"` or `{"Error": "..."}`.

Raw usage:

```bash
echo '{"FocusPane": {"direction": "left"}}' | nc -U /tmp/clawtab-desktop.sock
```

### Event push socket -- `/tmp/clawtab-events.sock`

The daemon also exposes a one-way event-push socket. Clients connect and read newline-delimited `IpcEvent` JSON values pushed by the daemon (job status changes, auto-yes changes, relay status, agent activity, etc.). No requests are sent.

Agent activity events use this shape:

```json
{"AgentActivityChanged": [{"pane_id": "%12", "working": true, "asking": false}]}
```

`GetAgentActivity` is an IPC-only command used by the tmux plugin; it is not a
user-facing `cwtctl` command. The plugin also requires `jq` to decode the local
JSON response. `working` is true for a short window after the daemon detects
new terminal scrollback or a repeated color-only animation in the visible
agent UI; echoed input and layout reflows are ignored. `asking` takes precedence
for that pane when a question is detected.
