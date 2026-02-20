# Quick Start

## Prerequisites

- macOS
- [tmux](https://github.com/tmux/tmux) installed
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (for Claude/Folder jobs)

## Installation

Build from source:

```bash
pnpm install
cargo tauri build
```

This produces three binaries:

| Binary | Purpose |
|--------|---------|
| `clawtab` | GUI app (Tauri window) |
| `cwtctl` | CLI for headless control |
| `cwttui` | Terminal UI (ratatui) |

## Setup Wizard

On first launch, the setup wizard walks through:

1. **Tools** -- Detects installed tools (editors, terminals, tmux, claude, gopass, aerospace)
2. **Terminal** -- Pick your terminal emulator
3. **Editor** -- Pick your code editor
4. **Secrets** -- Shows available secret backends (macOS Keychain, gopass)
5. **Telegram** -- Optional bot token + chat ID setup
6. **Done** -- Saves `settings.yaml`, marks setup complete

The wizard auto-detects tools and shows version + path for each. Missing tools can be installed via Homebrew directly from the UI.

## Creating Your First Job

### Binary job (run a script)

1. Open the Jobs panel
2. Click "New Job"
3. Set type to **Binary**
4. Set path to your script (e.g., `/path/to/backup.sh`)
5. Set a cron expression (e.g., `0 0 * * *` for daily at midnight)
6. Save

### Claude job (run a prompt)

1. Set type to **Claude**
2. Set path to a text file containing your prompt
3. The prompt file content is passed to `claude` via `$(cat /path/to/prompt.txt)`
4. Runs inside a tmux window named `cm-<job-name>`

### Folder job (project-based AI agent)

1. In ClawTab, click "New Job" and set type to **Folder**
2. Browse to your project root -- a `.cwt/` directory is created automatically
3. Enter a **Job Name** (e.g., "deploy", "lint") -- this creates a subfolder within `.cwt/`
4. Edit `.cwt/{job-name}/job.md` with your agent instructions
5. ClawTab auto-generates `.cwt/{job-name}/cwt.md` (job context)
6. Optionally add shared context in `.cwt/cwt.md` (applies to all jobs in the project)
7. The job runs Claude from the project root with shared + per-job context

Multiple jobs can share the same `.cwt/` directory, each in its own subfolder.

## Running a Job

- **GUI**: Click "Run Now" on any job
- **CLI**: `cwtctl run <name>`
- **TUI**: Select job, press `r`
- **Telegram**: Send `/run <name>` to your bot
- **Cron**: Automatically triggered based on the job's cron expression

## Checking Status

```bash
cwtctl status
```

Status values: `idle`, `running`, `success`, `failed`, `paused`.
