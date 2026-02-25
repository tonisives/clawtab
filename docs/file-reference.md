# File Reference

## Paths

| Path | Purpose |
|------|---------|
| `~/.config/clawtab/settings.yaml` | App settings |
| `~/.config/clawtab/history.db` | Run history (30-day retention) |
| `~/.config/clawtab/jobs/` | Job definitions directory |
| `~/.config/clawtab/jobs/<project>/<job-name>/job.yaml` | Individual job config |
| `~/.config/clawtab/jobs/<project>/<job-name>/logs/<run-id>.log` | Tmux job output log |
| `<project>/.cwt/cwt.md` | User-written shared context for all jobs in a project |
| `<project>/.cwt/<job-name>/job.md` | Job-specific prompt/instructions |
| `<project>/.cwt/<job-name>/cwt.md` | Auto-generated per-job context |
| `/tmp/clawtab.sock` | IPC Unix socket |

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
| `cli` | cwtctl or IPC command |
| `restart` | Restart command |

## Detected Tools

The setup wizard and Tools panel detect:

**Editors**: Neovim, Vim, VS Code, VSCodium, Zed, Helix, Sublime Text, Emacs

**Terminals**: Ghostty, Alacritty, Kitty, WezTerm, iTerm2, Terminal.app

**Other**: claude, tmux, git, aerospace, gopass

## Tmux Naming

Job tmux windows follow the pattern `cwt-<project>` within the configured session (default: `cwt`). The project name is derived from the slug prefix (the part before `/`).

Example: a job with slug `myapp/deploy` creates window `cwt:cwt-myapp`.

If the window already exists when a new run starts, ClawTab splits a new pane in the same window instead of creating a new one.
