# Architecture

## Overview

```mermaid
graph TB
    subgraph GUI["GUI (Tauri Window)"]
        React["React 19 Frontend"]
    end

    subgraph DesktopProc["Desktop App Process"]
        Commands["Tauri Commands"]
        DesktopIpc["Desktop IPC Server\n/tmp/clawtab-desktop.sock"]
    end

    subgraph DaemonProc["Daemon Process"]
        Scheduler["Cron Scheduler"]
        Executor["Job Executor"]
        Monitor["Pane Monitor"]
        IpcServer["Daemon IPC Server\n/tmp/clawtab.sock"]
        EventServer["Event Server\n/tmp/clawtab-events.sock"]
        TgPoller["Telegram Agent Poller"]
        RelayConn["Relay Client"]
    end

    subgraph External["External"]
        Tmux["tmux"]
        Claude["Claude Code CLI"]
        Keychain["macOS Keychain"]
        Gopass["gopass"]
        TgAPI["Telegram Bot API"]
    end

    subgraph Relay["Relay"]
        RelayServer["Relay Server"]
        Mobile["Mobile App"]
    end

    subgraph Clients["Clients"]
        CLI["cwtctl"]
        TUI["cwttui"]
    end

    React <-->|Tauri IPC| Commands
    Commands --> Executor
    Scheduler -->|30s poll| Executor
    Executor --> Tmux
    Executor --> Claude
    Monitor -->|2s poll| Tmux
    Monitor --> TgAPI
    Commands --> Keychain
    Commands --> Gopass
    TgPoller -->|8s poll| TgAPI
    TgPoller --> Executor
    CLI -->|Daemon socket| IpcServer
    CLI -->|Desktop socket| DesktopIpc
    TUI -->|Daemon socket| IpcServer
    DesktopIpc --> Commands
    EventServer -.->|push| Commands
    RelayConn <-->|WebSocket| RelayServer
    Mobile <-->|WebSocket| RelayServer
```

## Why two IPC sockets

The daemon owns background lifecycle (cron scheduling, job execution, relay, Telegram polling, auto-yes) and runs even when the GUI window is closed. It is intentionally UI-agnostic.

The desktop app owns UI state (focused pane, layout tree, splits). Operations that change UI state -- "focus the pane to the left", "open this tmux pane in the GUI" -- belong to the desktop process and are served on a separate socket at `/tmp/clawtab-desktop.sock`.

`cwtctl` picks the right socket per command. `cwtctl status` talks to the daemon; `cwtctl pane focus left` talks to the desktop app. Both sockets share the same wire format (newline-delimited JSON) and the same `IpcResponse` type, but each has its own command enum (`IpcCommand` for the daemon, `DesktopIpcCommand` for the desktop) so neither side ever deserializes the other's variants.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Tauri 2 |
| Frontend | React 19, TypeScript, Vite 7 |
| Core | Rust, Tokio |
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
    participant Tmux
    participant Monitor
    participant Telegram as Telegram API

    Trigger->>Executor: execute_job(job, trigger)
    Executor->>Executor: Insert RunRecord (status: Running)

    alt Binary Job
        Executor->>Executor: Spawn child process
        Executor->>Executor: Wait for exit
        Executor->>Telegram: Send completion notification
    else Claude/Folder Job
        Executor->>Tmux: Create window/pane
        Executor->>Tmux: send-keys (cd ... && claude ...)
        Executor->>Monitor: Spawn monitor task
        loop Every 2 seconds
            Monitor->>Tmux: capture-pane (last 80 lines)
            Monitor->>Monitor: Diff against previous
            Monitor->>Telegram: Relay new output
        end
        Note over Monitor: Process exit detected (200ms poll)
        Monitor->>Tmux: Capture full scrollback
        Monitor->>Tmux: Kill pane
        Monitor->>Telegram: Send completion notification
    end
```

## Source Layout

```
src-tauri/src/
  lib.rs                    # App state, IPC handler, Tauri setup
  main.rs                   # Entry point
  ipc.rs                    # Unix socket server/client (daemon + desktop sockets, IpcCommand + DesktopIpcCommand)
  config/
    mod.rs                  # Config dir: ~/.config/clawtab/
    jobs.rs                 # Job schema, folder-based storage, slug generation
    settings.rs             # AppSettings schema + persistence
  commands/
    jobs.rs                 # Job CRUD, run/pause/resume/restart
    history.rs              # History queries
    secrets.rs              # Secret management
    settings.rs             # Settings get/set
    telegram.rs             # Telegram config + setup polling
    relay.rs                # Relay login, pairing, token storage, status
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
  relay/
    mod.rs                  # WS connect loop, subscription check, message push
    handler.rs              # Incoming message handler (mobile commands)
  telegram/
    mod.rs                  # Send messages, notify, config struct
    commands.rs             # Agent command parsing + formatting
    polling.rs              # Long-poll getUpdates loop
    types.rs                # Telegram API types
  tmux/mod.rs               # tmux command wrappers
  cwt/mod.rs                # Job context management
  aerospace/mod.rs          # AeroSpace integration
  history/mod.rs            # Run history store
  tools/mod.rs              # Tool detection
  terminal/mod.rs           # Terminal emulator integration
  bin/
    ctl.rs                  # cwtctl CLI
    tui.rs                  # cwttui TUI

src/
  settings.tsx              # Frontend entry point
  types.ts                  # TypeScript interfaces (mirrors Rust structs)
  components/
    SettingsApp.tsx          # Main tabbed UI
    SetupWizard.tsx          # First-run wizard
    JobsTab.tsx              # Job list + management (uses shared JobListView)
    JobEditor.tsx            # Job creation/editing form
    SecretsPanel.tsx         # Secret management
    TelegramPanel.tsx        # Telegram settings
    TelegramSetup.tsx        # Telegram bot setup flow
    RelayPanel.tsx           # Remote access setup + status
    GeneralSettings.tsx      # App preferences
    ToolsPanel.tsx           # Tool detection + install
    CronInput.tsx            # Cron expression editor
    LogViewer.tsx            # Run log display
```

## Build Constraints

- `warnings = "deny"` and `unused = "deny"` in `Cargo.toml` -- dead code is a compile error
- Tauri command parameters: camelCase in JavaScript maps to snake_case in Rust
