# CLI & TUI

Both the CLI and TUI communicate with the running ClawTab GUI app via a Unix socket at `/tmp/clawtab.sock`. The GUI must be running for either to work.

## CLI: cwtctl

```
cwtctl <command> [args]
```

| Command | Description |
|---------|-------------|
| `ping` | Check if ClawTab is running |
| `list` / `ls` | List all job names |
| `run <name>` | Run a job |
| `pause <name>` | Pause a running job |
| `resume <name>` | Resume a paused job |
| `restart <name>` | Restart a completed/failed job |
| `status` | Show all job statuses as JSON |

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

The socket uses JSON-RPC over Unix domain socket, newline-delimited.

### Commands

```json
"Ping"
{"ListJobs": null}
{"RunJob": {"name": "daily-backup"}}
{"PauseJob": {"name": "daily-backup"}}
{"ResumeJob": {"name": "daily-backup"}}
{"RestartJob": {"name": "daily-backup"}}
"GetStatus"
"OpenSettings"
```

### Responses

```json
"Pong"
"Ok"
{"Jobs": ["daily-backup", "deploy"]}
{"Status": {"daily-backup": {"state": "idle"}, "deploy": {"state": "running", "run_id": "...", "started_at": "..."}}}
{"Error": "Job not found"}
```

### Raw Usage

```bash
echo '"Ping"' | nc -U /tmp/clawtab.sock
```
