# File Reference

## Paths

| Path | Purpose |
|------|---------|
| `~/.config/clawdtab/settings.yaml` | App settings |
| `~/.config/clawdtab/history.db` | SQLite run history (30-day retention) |
| `~/.config/clawdtab/jobs/` | Job definitions directory |
| `~/.config/clawdtab/jobs/<slug>/job.yaml` | Individual job config |
| `~/.config/clawdtab/jobs/<slug>/logs/<run-id>.log` | Tmux job output log |
| `/tmp/clawdtab.sock` | IPC Unix socket |

## Job Status Values

| State | Fields | Meaning |
|-------|--------|---------|
| `idle` | -- | Never run or reset |
| `running` | `run_id`, `started_at` | Currently executing |
| `success` | `last_run` | Last run exited 0 |
| `failed` | `last_run`, `exit_code` | Last run exited non-zero |
| `paused` | -- | Manually paused |

## Trigger Types

| Trigger | Source |
|---------|--------|
| `manual` | GUI "Run Now" button |
| `cron` | Scheduler match |
| `cli` | cwdtctl or IPC command |
| `restart` | Restart command |

## Detected Tools

The setup wizard and Tools panel detect:

**Editors**: Neovim, Vim, VS Code, VSCodium, Zed, Helix, Sublime Text, Emacs

**Terminals**: Ghostty, Alacritty, Kitty, WezTerm, iTerm2, Terminal.app

**Other**: claude, tmux, git, aerospace, gopass

## Tmux Naming

Job tmux windows follow the pattern `cm-<job-name>` within the configured session (default: `tgs`).

Example: job "daily-backup" creates window `tgs:cm-daily-backup`.

If a window's pane has an active process when a new run starts, ClawdTab splits a new pane in the same window instead of waiting.
