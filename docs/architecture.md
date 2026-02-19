# Architecture

## Overview

```mermaid
graph TB
    subgraph GUI["GUI (Tauri Window)"]
        React["React 19 Frontend"]
    end

    subgraph Backend["Rust Backend"]
        Commands["Tauri Commands"]
        Scheduler["Cron Scheduler"]
        Executor["Job Executor"]
        Monitor["Pane Monitor"]
        IpcServer["IPC Server"]
        TgPoller["Telegram Agent Poller"]
    end

    subgraph External["External"]
        Tmux["tmux"]
        Claude["Claude Code CLI"]
        Keychain["macOS Keychain"]
        Gopass["gopass"]
        TgAPI["Telegram Bot API"]
        SQLite["SQLite (history.db)"]
    end

    subgraph Clients["Clients"]
        CLI["cwdtctl"]
        TUI["cwdttui"]
    end

    React <-->|Tauri IPC| Commands
    Commands --> Executor
    Scheduler -->|30s poll| Executor
    Executor --> Tmux
    Executor --> Claude
    Executor -->|binary jobs| SQLite
    Monitor -->|5s poll| Tmux
    Monitor --> SQLite
    Monitor --> TgAPI
    Commands --> SQLite
    Commands --> Keychain
    Commands --> Gopass
    TgPoller -->|8s poll| TgAPI
    TgPoller --> Executor
    CLI -->|Unix socket| IpcServer
    TUI -->|Unix socket| IpcServer
    IpcServer --> Commands
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Tauri 2 |
| Frontend | React 19, TypeScript, Vite 7 |
| Backend | Rust, Tokio |
| Database | SQLite (rusqlite) |
| Serialization | serde_yml (config), serde_json (IPC) |
| Cron parsing | `cron` crate |
| HTTP client | reqwest (Telegram API) |
| TUI | ratatui + crossterm |

## Shared State

All mutable state is wrapped in `Arc<Mutex<T>>` and shared across the scheduler, executor, IPC handler, and Tauri commands:

```rust
AppState {
    jobs_config:  Arc<Mutex<JobsConfig>>,
    settings:     Arc<Mutex<AppSettings>>,
    secrets:      Arc<Mutex<SecretsManager>>,
    history:      Arc<Mutex<HistoryStore>>,
    job_status:   Arc<Mutex<HashMap<String, JobStatus>>>,
}
```

MutexGuards are always dropped before any `.await` to satisfy Rust's `Send` bounds.

## Execution Flow

```mermaid
sequenceDiagram
    participant Trigger as Trigger (GUI/CLI/Cron/Telegram)
    participant Executor
    participant History as SQLite
    participant Tmux
    participant Monitor
    participant Telegram as Telegram API

    Trigger->>Executor: execute_job(job, trigger)
    Executor->>History: Insert RunRecord (status: Running)

    alt Binary Job
        Executor->>Executor: Spawn child process
        Executor->>Executor: Wait for exit
        Executor->>History: Update (exit_code, stdout, stderr)
        Executor->>Telegram: Send completion notification
    else Claude/Folder Job
        Executor->>Tmux: Create window/pane
        Executor->>Tmux: send-keys (export ... && cd ... && claude ...)
        Executor->>Monitor: Spawn monitor task
        loop Every 5 seconds
            Monitor->>Tmux: capture-pane (last 80 lines)
            Monitor->>Monitor: Diff against previous
            Monitor->>Telegram: Relay new output
        end
        Note over Monitor: 5 idle ticks = done
        Monitor->>Tmux: Capture full scrollback
        Monitor->>History: Update (output, finished_at)
        Monitor->>Telegram: Send completion notification
    end
```

## Source Layout

```
src-tauri/src/
  lib.rs                    # App state, IPC handler, Tauri setup
  main.rs                   # Entry point
  ipc.rs                    # Unix socket server/client
  config/
    mod.rs                  # Config dir: ~/.config/clawdtab/
    jobs.rs                 # Job schema, folder-based storage, slug generation
    settings.rs             # AppSettings schema + persistence
  commands/
    jobs.rs                 # Job CRUD, run/pause/resume/restart
    history.rs              # History queries
    secrets.rs              # Secret management
    settings.rs             # Settings get/set
    telegram.rs             # Telegram config + setup polling
    status.rs               # Job status queries
    tmux.rs                 # Tmux session/window operations
    tools.rs                # Tool detection + installation
    aerospace.rs            # Aerospace workspace listing
  scheduler/
    mod.rs                  # 30s cron polling loop
    executor.rs             # Job execution (binary/claude/folder)
    monitor.rs              # Tmux pane monitoring + log capture
  secrets/
    mod.rs                  # SecretsManager (unified lookup)
    keychain.rs             # macOS Keychain backend
    gopass.rs               # Gopass backend
  telegram/
    mod.rs                  # Send messages, notify, config struct
    commands.rs             # Agent command parsing + formatting
    polling.rs              # Long-poll getUpdates loop
    types.rs                # Telegram API types
  tmux/mod.rs               # tmux command wrappers
  cwdt/mod.rs               # .cwdt folder handling
  aerospace/mod.rs          # AeroSpace integration
  history/mod.rs            # SQLite history store
  tools/mod.rs              # Tool detection
  terminal/mod.rs           # Terminal emulator integration
  browser/mod.rs            # Browser auth (Playwright, deferred)
  bin/
    ctl.rs                  # cwdtctl CLI
    tui.rs                  # cwdttui TUI

src/
  settings.tsx              # Frontend entry point
  types.ts                  # TypeScript interfaces (mirrors Rust structs)
  components/
    SettingsApp.tsx          # Main tabbed UI
    SetupWizard.tsx          # First-run wizard
    JobsPanel.tsx            # Job list + management
    JobEditor.tsx            # Job creation/editing form
    SecretsPanel.tsx         # Secret management
    TelegramPanel.tsx        # Telegram settings
    TelegramSetup.tsx        # Telegram bot setup flow
    GeneralSettings.tsx      # App preferences
    ToolsPanel.tsx           # Tool detection + install
    CronInput.tsx            # Cron expression editor
    LogViewer.tsx            # Run log display
```

## History

SQLite database at `~/.config/clawdtab/history.db`.

```sql
CREATE TABLE runs (
    id TEXT PRIMARY KEY,          -- UUID v4
    job_name TEXT NOT NULL,
    started_at TEXT NOT NULL,     -- RFC 3339
    finished_at TEXT,
    exit_code INTEGER,
    trigger_type TEXT NOT NULL,   -- "manual" | "cron" | "cli" | "restart"
    stdout TEXT NOT NULL DEFAULT '',
    stderr TEXT NOT NULL DEFAULT ''
);
```

- Entries older than 30 days are auto-pruned on startup
- Last 100 entries returned by default
- Per-job queries return last 10 runs

## Build Constraints

- `warnings = "deny"` and `unused = "deny"` in `Cargo.toml` -- dead code is a compile error
- Tauri command parameters: camelCase in JavaScript maps to snake_case in Rust
