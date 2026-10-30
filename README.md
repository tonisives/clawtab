<h3 align="center">ClawTab - Tmux-Native Agent Control Plane</h3>

<p align="center">
  Run Claude Code, Codex, OpenCode, Hermes, and shell jobs in durable tmux panes or managed terminals, then control the same sessions from your terminal, desktop, web, or phone.
</p>

<p align="center">
  <a href="https://cdn.clawtab.cc/assets/home/tmux-main.mp4?v=20260716">
    <img src="https://cdn.clawtab.cc/assets/home/tmux-main-readme.webp?v=20260717" alt="ClawTab managing live agents in tmux" width="1000" />
  </a>
</p>

<p align="center">
  <a href="https://clawtab.cc">Website</a> &middot;
  <a href="./docs/">Documentation</a> &middot;
  <a href="https://clawtab.cc/articles/daemon-tmux-control-plane">Tmux architecture</a>
</p>

---

## Downloads

| Platform | Availability |
| --- | --- |
| macOS | Daemon and CLI: `brew install --cask tonisives/tap/clawtab`. Optional desktop app: `brew install --cask tonisives/tap/clawtab-desktop` |
| Linux | Local daemon or remote agent host: [x86_64](https://github.com/tonisives/clawtab/releases/latest/download/clawtab-linux-x86_64.tar.gz) / [ARM64](https://github.com/tonisives/clawtab/releases/latest/download/clawtab-linux-aarch64.tar.gz) |
| Windows | Native host and CLI: build from source or use the [Managed terminals CI artifact](https://github.com/tonisives/clawtab/actions/workflows/managed-sessions.yml). No WSL required. |
| iPhone / iPad | [App Store](https://apps.apple.com/us/app/clawtab/id6759683841) |
| Android | Google Play build workflow added; store release pending signing and submission |
| Web | [Remote](https://remote.clawtab.cc) |

See [platform installation and release builds](docs/platform-builds.md).

## Tmux Is the Workspace

ClawTab keeps agents in real tmux panes instead of hiding them inside a desktop-only runtime. Your process, working directory, scrollback, and terminal state survive app restarts and remain available through normal tmux commands.

A headless daemon adds the agent-aware layer: schedules, session metadata, task titles, question detection, auto-yes, notifications, and Remote connections. The terminal, desktop app, and Remote clients all connect to the same pane IDs, so changing interfaces does not restart or duplicate an agent.

<p align="center">
  <img src="https://cdn.clawtab.cc/assets/articles/daemon-tmux/agents-side-by-side.png?v=20260717" alt="Two Codex agents working side by side in the same tmux window" width="1000" />
</p>

<p align="center"><em>Two Codex agents work side by side in the same tmux window.</em></p>

## Features

- **Durable tmux sessions** - Agents remain ordinary, inspectable tmux panes with their real terminal state intact.
- **Headless control plane** - The launchd daemon keeps jobs, monitoring, relay connections, and auto-yes running without the desktop window.
- **Agent-aware tmux UI** - See working, waiting, and idle states; replace generic process names with useful task titles.
- **Terminal-native controls** - Use `cwtctl`, `cwttui`, or the tmux popup to manage agents and scheduled jobs.
- **Session continuity** - Open the same pane in tmux, the desktop app, web Remote, or mobile without starting a new process.
- **Multiple providers** - Run Claude Code, Codex, OpenCode, Antigravity, Hermes, and normal shells in one workspace.
- **Scheduled jobs** - Create prompt, project-folder, and binary jobs with cron expressions or calendar-anchored weekly recurrences.
- **Remote answers** - View live output and answer agent questions from web, mobile, push notifications, or Telegram.
- **Secrets management** - Inject selected macOS Keychain or gopass secrets into jobs without storing them in project files.
- **Optional visual workspace** - Arrange split panes and use the agent Mind Map in the Tauri desktop app.

Hermes supports live terminal control, session information, hook-driven activity, approvals, and scheduled launches. See [Hermes setup and validation](docs/hermes.md).

### Small Bundle

ClawTab is built with Rust and Tauri. The desktop bundle is under 20 MB, while the daemon handles background work independently of the GUI.

## Work from Tmux

The bundled tmux plugin adds agent status, task-based pane names, auto-yes controls, session forking, skill search, secret injection, and a terminal sidebar.

Window tabs show a colored age before the agent status: `jn` under a minute, then `13m`, `2h`, or `3d` since the latest agent action in that window. Ages are green under an hour, amber under a day, and red from one day onward. Agent events and new output update the timestamp; focus changes, spinner repaints, and layout changes do not. Windows without a known agent action omit the age.

The daemon publishes agent activity to tmux without replacing your theme. Working windows get a cyan activity marker, agents asking for input get a yellow attention marker, and present-but-idle agents get a green check.

Each pane ends its top border with the same state icons as window titles: cyan `*` for working, yellow `!` for waiting, orange `!` for alerts, and green `✓` for idle. Pane information shows the title followed by the activity age; narrow panes shorten ages such as `2h ago` to `2h`. These labels use the daemon's cached snapshot, so panes in the same window can show different states without running a CLI query on every redraw.

The daemon repairs missed lifecycle hooks for Codex, Claude, OpenCode, and Hermes after startup and in paced recovery rounds. Rounds start at least ten minutes apart and inspect one session every five seconds, prioritizing older working markers. Confirmed idle sessions leave the queue until a new hook arrives. Unresolved sessions back off to twenty, forty, then eighty minutes. Normal hook events still update status immediately.

Recovery reads provider records directly: bounded transcript tails for Claude and Codex, read-only SQLite for Hermes, and OpenCode's local session-status API with a SQLite fallback for older integrations. Database work has a 50 ms query budget, API requests time out after 250 ms, and recovery never captures pane contents or launches provider commands. It requires explicit terminal evidence; low CPU use or a quiet terminal does not imply completion. Recovered states do not replay historical completion messages.

ClawTab picks up generated session names from Codex, Claude Code, OpenCode, and Hermes as they become available, usually on the next five-second scan. The name appears in ClawTab and on the top pane border. A window with exactly one agent also gets that name if tmux's automatic naming is enabled. Windows with multiple agents keep their window name. Explicitly renaming a window stops ClawTab from renaming it again; existing named windows and custom pane names are preserved.

<p align="center">
  <img src="https://cdn.clawtab.cc/assets/articles/daemon-tmux/tmux-agent-working.png?v=20260716" alt="Tmux status bar showing working and idle activity indicators across AI agent windows" width="1000" />
</p>

<p align="center"><em>Activity indicators make working, waiting, and idle agent windows visible before you enter them.</em></p>

The status bar uses a cyan `*` for working agents, a yellow `!` for questions, and an orange `!` for alerts. Alerts detect capacity, overload, rate limit, quota, authentication, and connection failures in the latest terminal error block. They clear when work resumes or newer output replaces the error. Entering a window focuses panes with questions or alerts. Process cards label alerts and show the error text in their status tooltip.

Agent alerts also appear in desktop and remote notification cards, with an action to open the affected session. New alerts send an iOS push when remote notifications are enabled. Repeated snapshots update the same card; recovery or session exit resolves it.

Add the plugin to `.tmux.conf`:

```sh
run-shell /path/to/clawtab/tmux-clawtab/clawtab.tmux
```

Then reload tmux:

```sh
tmux source-file ~/.tmux.conf
```

### Default Keybindings

| Key | Action |
|-----|--------|
| `prefix + E` | Open a floating ClawTab menu over the current pane |
| `prefix + y` | Toggle auto-yes for the current agent pane |
| `prefix + o` | Open the current pane in the ClawTab desktop app |
| `prefix + s` | Search skills and insert a skill command |
| `prefix + f` | Fork the current agent session into a new pane |
| `` prefix + ` `` | Open the ClawTab terminal sidebar |

The floating menu has Home, Plugins, Secrets, and Skills tabs. Plugins lists matching actions from installed local plugins for the current pane and runs the selected action with Enter. ClawTab installs no agent actions by default. It also shows provider usage, session start time, first and latest queries, session ID, and restore context. Each agent pane can have its own floating menu, and the rest of tmux remains interactive while it is open. Opening the menu again from the same agent focuses its existing floating pane.

The floating menu uses 95% of its target pane by default. Customize its size or restore the original client-modal popup in `.tmux.conf`:

```tmux
set -g @clawtab-menu-size 85
# set -g @clawtab-menu-mode popup
```

Floating panes require tmux 3.7 or newer. Older versions fall back to the original popup.

All keys can be customized through tmux options.

## Control from the CLI

`cwtctl` works without the desktop app. Job control talks to the daemon; job creation writes local config and also works while the daemon is offline.

```sh
cwtctl daemon status
cwtctl jobs list
cwtctl jobs run my-project/review
cwtctl jobs status
cwtctl agent info %16
cwtctl agent auto-yes toggle %16
cwtctl plugin installed --json
cwtctl plugin list
cwtctl plugin <name> run [pane_id] [key=value ...]
```

Run `cwtctl jobs create` from a project directory for the interactive form and `nvim` description editor. It creates an agent job in the nearest configured group whose `folder_path` contains the current directory, or derives a group from the directory name when there is no match. You can also supply every field on the command line:

```sh
cwtctl jobs create --name daily-review --cron '0 9 * * *' --description-file review.md
cwtctl jobs create --name follow-up --at '2026-10-02 09:00' --description 'Check the results'
cat task.md | cwtctl jobs create --name task --at '2026-10-02T09:00:00+07:00' --description-stdin --keep-config
```

One-time jobs run when the daemon returns if their scheduled time passed while it was offline. By default, their config is removed after the agent starts, while the pane and run history remain available. `--keep-config` leaves the job disabled after launch.

The CLI accepts one description source: inline text, a text or Markdown file, or standard input. `--at` accepts a future local `YYYY-MM-DD HH:MM` date or RFC 3339 timestamp. `cwtctl jobs create` creates agent jobs; use the desktop app to create a Binary job that runs a script directly.

Agent actions are optional local executables. ClawTab installs none by default.
Plugin packages are hot-discovered from
`~/.config/clawtab/agent-plugins/<plugin-id>/plugin.yaml`; edits do not require
a daemon restart. Plugin names can use a unique action suffix, with dashes in
place of underscores. See [Local Executable Plugins](./docs/agent-plugins.md)
for the package format, host commands, and approval flow.

For an interactive agent job, `cwtctl jobs run` waits for the daemon to publish its terminal and then attaches your terminal to it. If you are already inside tmux, it selects the new pane in the current client.

<p align="center">
  <img src="https://cdn.clawtab.cc/assets/articles/daemon-tmux/cwtctl-command-groups.png?v=20260716" alt="cwtctl command groups for agents, jobs, panes, secrets, Telegram, and the daemon" width="1000" />
</p>

## Managed CLI sessions

New in [ClawTab 0.6.0](docs/release-notes.md). Follow the [session guide](docs/managed-sessions.md) for setup and recovery.

ClawTab also supports agents without tmux. Launch the command through ClawTab so a separate owner process can keep its terminal alive:

```sh
cwtctl session start -- codex
cwtctl session start -- claude
cwtctl session start --detached -- opencode
cwtctl session list
cwtctl session attach managed:<session-id>
cwtctl session capture managed:<session-id> --history
cwtctl session stop managed:<session-id>
```

These sessions use a Unix PTY on macOS/Linux and ConPTY on Windows. They appear beside tmux sessions in ClawTab. The owner keeps the process, terminal screen, and up to 10,000 history rows while the desktop app or daemon restarts. Existing commands started outside ClawTab cannot be adopted; launch them through `cwtctl session start`.

Closing the originating terminal keeps its agent running by default. Use `--close-with-terminal` to stop it when that terminal closes, or `--keep-running` to override the global preference. In an attached terminal, press Ctrl+] then d to detach deliberately; explicit detach keeps the process running with either policy.

Taking control on mobile resizes the agent to the mobile terminal. The first local key reclaims control and is consumed. ClawTab restores the latest local terminal dimensions, including any desktop resize while mobile had control. Remote control has a renewable 30-second lease; losing the host connection also releases it. Watching clients cannot resize or type without taking control.

After an owner crash or computer restart, the session is marked interrupted. `cwtctl session resume <id>` explicitly resumes its saved provider conversation when available. It never automatically replays the original prompt. Enable the provider's ClawTab hooks to retain conversation identity and immediate question/activity events.

Choose the default under Settings > Runtime, or set `terminal_backend: managed` / `terminal_backend: tmux` in an individual job's YAML. Windows defaults to managed sessions; existing Unix installations retain tmux as their default. Scheduling, captured output, notifications, question detection, auto-yes, and compatible agent plugins use either backend. Tmux layouts, copy mode, and Move remain tmux features. Use History or `session capture --history` for managed scrollback.

### Native Windows host

Windows 10 version 1809 or newer is required. Install your agent CLI, extract the Windows host package, verify its SHA-256 checksum, and run `powershell -ExecutionPolicy Bypass -File .\install.ps1` from that extracted package. Then run `cwtctl setup` and approve its pairing code in the mobile app. Setup registers per-user startup at login; it does not require administrator privileges. Python is needed only for Python plugins, and Git for repository operations.

For a source build:

```powershell
cd desktop/src-tauri
cargo build -j4 --release --no-default-features --bin cwtctl --bin clawtab-daemon --bin clawtab-hook
.\target\release\cwtctl.exe setup
.\target\release\cwtctl.exe session start -- codex
```

The installer puts each version in a separate directory and updates the CLI shim and startup path. Updating the host leaves existing owners on their original executable until their sessions end. Keep those older directories while their sessions are running. This package provides the Windows host and CLI; the Tauri desktop UI remains a separate platform target.

## Optional GUI and Mind Map

ClawTab works headlessly through tmux, the daemon, and `cwtctl`. The macOS GUI is optional: open it when you want visual split workspaces or a Mind Map of running Claude Code, Codex, and OpenCode agents. Click an agent in the map to open its live tmux terminal, then close the GUI without stopping the session.

<p align="center">
  <img src="https://cdn.clawtab.cc/assets/articles/mind-map/mindmap-claude-and-codex.png" alt="ClawTab Mind Map with agent hubs and live terminal windows" width="1000" />
</p>

Read more in the [Mind Map article](https://clawtab.cc/articles/mind-map).

## Remote Control

- **Live terminal** - View and control the same tmux pane from the web or mobile app.
- **Automatic question detection** - Detect when supported agents are waiting for input.
- **One-tap answers** - Render answer choices as buttons and send the response to the pane.
- **Multi-agent support** - Follow questions and output across providers, projects, and tmux windows.

<p align="center">
  <a href="https://clawtab.cc/assets/remote/app-preview.mp4">
    <img src="https://cdn.clawtab.cc/assets/remote/app-preview-readme.webp?v=20260717" alt="ClawTab mobile app showing remote agent controls" width="500" />
  </a>
</p>

The daemon owns the tmux sessions and connects to the Rust/Axum relay. Web and mobile clients receive terminal output and send input through the relay back to the original pane.

```text
tmux pane <-> ClawTab daemon <-> Relay server <-> Web or mobile client
```

## How It Works

1. **Start in tmux** - Run an agent normally or launch a configured job through `cwtctl`, `cwttui`, the desktop app, Telegram, or a schedule.
2. **Discover the session** - The daemon associates provider metadata, activity, questions, and a useful task title with the pane ID.
3. **Keep it alive** - tmux preserves the process and terminal state while the daemon keeps schedules and integrations running.
4. **Open it anywhere** - Attach through tmux or view the same pane from the desktop, web, or mobile interface.
5. **Answer from any client** - Input is routed back to the original pane, so the agent continues in one durable session.

## Save Costs

Mix providers without reorganizing your workspace or giving up session visibility:

- Use Claude Code when it fits the task and current allowance.
- Switch to Codex when another model or subscription is a better fit.
- Keep OpenCode available as an additional provider and model gateway.

## Install

### Homebrew

```sh
brew install --cask tonisives/tap/clawtab
cwtctl daemon install
cwtctl daemon status
```

The daemon starts at login through launchd and continues running independently of the desktop app.

The default package installs the daemon, `cwtctl`, agent hooks, and Zsh completion. Add the desktop app separately for split workspaces, the Mind Map, and visual settings:

```sh
brew install --cask tonisives/tap/clawtab-desktop
```

### Build from Source

Requires macOS 10.15+, [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/), and tmux.

```sh
git clone https://github.com/tonisives/clawtab.git
cd clawtab
pnpm install
cargo tauri build
```

| Binary | Purpose |
|--------|---------|
| `clawtab-daemon` | Headless scheduler, agent monitor, relay client, PTY owner, and IPC server |
| `cwtctl` | CLI for agents, jobs, panes, secrets, Telegram, and daemon lifecycle |
| `cwttui` | Terminal job interface built with ratatui |
| `clawtab` | Optional Tauri GUI for split workspaces, Mind Map, settings, and history |

### Runtime Dependencies

- tmux
- At least one supported agent CLI, such as Claude Code, Codex, or OpenCode

## iOS App

Download ClawTab from the [App Store](https://apps.apple.com/us/app/clawtab/id6759683841).

## Web Remote

Access the hosted Remote at [remote.clawtab.cc](https://remote.clawtab.cc).

## Relay

The relay is required for Web Remote and the iOS app. You can deploy it yourself or use the hosted service at `relay.clawtab.cc`.

## Documentation

Full documentation is available in the [docs](./docs/) folder or at [clawtab.cc](https://clawtab.cc).

- [Quick Start](./docs/quick-start.md)
- [CLI and TUI](./docs/cli-tui.md)
- [Architecture](./docs/architecture.md)
- [Remote Access](./docs/remote.md)
- [Job Types](./docs/job-types.md)
- [Secrets](./docs/secrets.md)
- [Telegram](./docs/telegram.md)
- [Workspace Sharing](./docs/sharing.md)
- [Vim and tmux Navigation](./docs/vim-tmux-navigation.md)
- [Self-hosted Deployment](./docs/deploy.md)

## License

ClawTab is available under the [MIT License](./LICENSE).

## FAQ

### Why Not Just Use Tmux?

Tmux remains the workspace. ClawTab adds the agent-specific control plane around it: task titles, working and waiting states, question detection, auto-yes, schedules, secrets, notifications, session search, and access from desktop or mobile. You can keep using normal tmux commands and remove ClawTab without losing a proprietary session format.

### Do I Need to Keep the Desktop App Open?

No. The daemon runs through launchd and owns background scheduling, monitoring, notifications, and Remote connectivity. The desktop app is an optional visual client.

### What Is the Difference Between OpenClaw and ClawTab?

ClawTab includes autonomous jobs, schedules, and remote notifications, with an emphasis on keeping agent sessions in tmux and making those same panes available through terminal, desktop, web, and mobile interfaces.

### Why Not Just Use Claude Code?

ClawTab does not replace the agent CLI. It lets Claude Code, Codex, OpenCode, and normal shells share one manageable tmux workspace, so you can choose the best provider for each task.

### What Is the Pricing?

The desktop app and local tools are MIT licensed and free. You can self-host the relay for free or use the hosted Remote subscription.
