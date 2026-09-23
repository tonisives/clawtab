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
| `jobs create` | Create a scheduled agent job in the current project directory; works without the daemon |
| `jobs run <group>/<job>` | Run a job and follow its output |
| `jobs pause <group>/<job>` | Pause a running job |
| `jobs resume <group>/<job>` | Resume a paused job |
| `jobs restart <group>/<job>` | Restart a completed/failed job |
| `jobs status` | Show all job statuses as JSON |
| `usage <provider>` | Show local quota usage for `claude`, `codex`, `antigravity`, or `zai` |
| `secrets` / `secrets get <k>...` | Secret access |
| `telegram send <message>` | Send a Telegram message |

### Agent commands

| Command | Description |
|---------|-------------|
| `agent auto-yes` | Show panes with auto-yes enabled |
| `agent auto-yes toggle [pane_id]` | Toggle auto-yes for a pane |
| `agent auto-yes check [pane_id]` | Check auto-yes (exit 0=on, 1=off) |
| `agent info [pane_id]` | Show first query / session date for an agent pane |
| `agent info restore-command [pane_id]` | Print a restore command for an agent pane |
| `agent rename <pane_id> <title>` | Set the pane name shown on every connected surface |
| `agent pin [pane_id]` | Pin the pane across tmux, desktop, web, and mobile; defaults to `$TMUX_PANE` |
| `agent unpin [pane_id]` | Remove the shared pane pin; defaults to `$TMUX_PANE` |
| `agent actions [pane_id] [--json]` | List the agent actions available for a pane |
| `agent action run <id> [pane_id] [key=value ...]` | Start an action by its full action ID |
| `agent action status <run_id>` | Show an action run |
| `agent action cancel <run_id>` | Cancel an action run |

### Plugin commands

ClawTab installs no agent actions by default. Local executable plugins live at
`~/.config/clawtab/agent-plugins/<plugin-id>/plugin.yaml` and are discovered
when actions are listed or started. See [Local Executable Plugins](./agent-plugins.md)
for the manifest, host API, capabilities, and approval rules.

```sh
cwtctl plugin installed --json
cwtctl plugin approve <plugin-id> <fingerprint>
cwtctl plugin revoke <plugin-id>
cwtctl plugin list
cwtctl plugin <name> run [pane_id] [key=value ...]
cwtctl plugin <name> status <run_id>
cwtctl plugin <name> cancel <run_id>
```

`plugin list` shows actions matching the current pane's provider and version.
Activation mismatches are hidden. Matching untrusted or invalid actions are not
available to run. When no pane ID is supplied, `cwtctl` uses `$TMUX_PANE`.
Plugin runs return a JSON run record immediately; use `status` to poll the
asynchronous action.

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
| `pane open [pane_id]` | Open a tmux pane in the ClawTab GUI |
| `pane focus <left\|right\|up\|down>` | Move focus between ClawTab panes |

`pane focus` is intended to be called from `tmux.conf` and vim/nvim configs to share `Ctrl-h/j/k/l` navigation between vim windows, tmux panes, and ClawTab panes. See [Vim / Tmux Navigation](./vim-tmux-navigation.md).

Exit codes: `0` on success, `1` on error (with message on stderr).

### Create a scheduled agent job

Run `cwtctl jobs create` from the project directory. The interactive form accepts a name and either a cron expression or a one-time date. Press `Tab` to change fields, `Ctrl-R` to switch schedule type, and `Ctrl-K` to toggle one-time config cleanup. Press `Enter` to write the description in `nvim`; `Esc` cancels.

For a command without prompts, supply a name, exactly one schedule, and exactly one description source:

```bash
cwtctl jobs create --name daily-review --cron '0 9 * * *' --description-file review.md
cwtctl jobs create --name follow-up --at '2026-10-02 09:00' --description 'Check the results'
cat task.md | cwtctl jobs create --name task --at '2026-10-02T09:00:00+07:00' --description-stdin --keep-config
```

`--at` accepts a local `YYYY-MM-DD HH:MM` time or RFC 3339 with an explicit offset. The date must be in the future when the job is created. `--description-file` reads a text or Markdown file. These commands create agent jobs with descriptions stored in `job.md`; use the desktop app to configure a Binary job that runs a script directly.

The command finds the nearest configured job group whose `folder_path` contains the current directory. If none matches, it uses a group derived from the current directory name. Job files are stored under `~/.config/clawtab/jobs/<group>/<name>/`.

One-time jobs due while the daemon was offline run when it returns. By default, the daemon removes their config after the agent starts; the tmux pane and run history stay available for inspection. `--keep-config` leaves the job disabled after launch. Cron jobs keep their config and repeat.

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
