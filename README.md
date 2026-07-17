<h3 align="center">ClawTab - Tmux-Native Agent Control Plane</h3>

<p align="center">
  Run Claude Code, Codex, OpenCode, and shell jobs in durable tmux panes, then control the same sessions from your terminal, desktop, web, or phone.
</p>

<p align="center">
  <video src="https://cdn.clawtab.cc/assets/home/tmux-main.mp4?v=20260716" poster="https://cdn.clawtab.cc/assets/home/tmux-main-poster.jpg?v=20260716" width="1000" controls autoplay muted loop playsinline>
    <a href="https://cdn.clawtab.cc/assets/home/tmux-main.mp4?v=20260716">Watch ClawTab running tmux agents</a>
  </video>
</p>

<p align="center">
  <a href="https://clawtab.cc">Website</a> &middot;
  <a href="./docs/">Documentation</a> &middot;
  <a href="https://clawtab.cc/articles/daemon-tmux-control-plane">Tmux architecture</a>
</p>

---

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
- **Multiple providers** - Run Claude Code, Codex, OpenCode, Antigravity, and normal shells in one workspace.
- **Scheduled jobs** - Create prompt, project-folder, and binary jobs with standard cron expressions.
- **Remote answers** - View live output and answer agent questions from web, mobile, push notifications, or Telegram.
- **Secrets management** - Inject selected macOS Keychain or gopass secrets into jobs without storing them in project files.
- **Optional visual workspace** - Arrange split panes and use the agent Mind Map in the Tauri desktop app.

### Small Bundle

ClawTab is built with Rust and Tauri. The desktop bundle is under 20 MB, while the daemon handles background work independently of the GUI.

## Work from Tmux

The bundled tmux plugin adds agent status, task-based pane names, auto-yes controls, session forking, skill search, secret injection, and a terminal sidebar.

The daemon publishes agent activity to tmux without replacing your theme. Working windows get a cyan activity marker, agents asking for input get a yellow attention marker, and present-but-idle agents get a green check.

<p align="center">
  <img src="https://cdn.clawtab.cc/assets/articles/daemon-tmux/tmux-agent-working.png?v=20260716" alt="Tmux status bar showing working and idle activity indicators across AI agent windows" width="1000" />
</p>

<p align="center"><em>Activity indicators make working, waiting, and idle agent windows visible before you enter them.</em></p>

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
| `prefix + E` | Open the ClawTab popup with Home, Secrets, and Skills tabs |
| `prefix + y` | Toggle auto-yes for the current agent pane |
| `prefix + o` | Open the current pane in the ClawTab desktop app |
| `prefix + s` | Search skills and insert a skill command |
| `prefix + f` | Fork the current agent session into a new pane |
| `` prefix + ` `` | Open the ClawTab terminal sidebar |

The popup also shows provider usage, session start time, first and latest queries, session ID, and restore context. All keys can be customized through tmux options.

## Control from the CLI

`cwtctl` talks directly to the daemon, so the desktop app does not need to be open.

```sh
cwtctl daemon status
cwtctl jobs list
cwtctl jobs run my-project/review
cwtctl jobs status
cwtctl agent info %16
cwtctl agent auto-yes toggle %16
```

For an interactive agent job, `cwtctl jobs run` waits for the daemon to publish the tmux pane and then attaches your terminal to it. If you are already inside tmux, it selects the new pane in the current client.

<p align="center">
  <img src="https://cdn.clawtab.cc/assets/articles/daemon-tmux/cwtctl-command-groups.png?v=20260716" alt="cwtctl command groups for agents, jobs, panes, secrets, Telegram, and the daemon" width="1000" />
</p>

## Full Terminal Support

ClawTab uses [xterm.js](https://github.com/xtermjs/xterm.js) to show the same terminal in the desktop and Remote interfaces. You can answer questions, edit in Neovim, and use your full shell configuration. Normal shells can sit beside agent panes and be used for any purpose.

<p align="center">
  <img src="docs/readme-pics/agent-and-shell-side-by-side.png" alt="An agent and a shell open side by side" width="1000" />
</p>

## Mind Map

The Mind Map lays out every running Claude Code, Codex, and OpenCode agent as a recency-weighted constellation around its group hub. Recently active agents sit close and large, while idle agents drift to the edge. Click a node to open its live tmux terminal without leaving the canvas.

- **Recency layout** - Card size, opacity, and edge weight reflect recent activity.
- **Agents and Jobs modes** - Switch between live agent processes and scheduled jobs.
- **State at a glance** - Working agents and panes waiting for input have distinct states.
- **Multiple live terminals** - Open several draggable, resizable terminal windows at once.
- **Spawn from a hub** - Launch a new agent directly into a project group.

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
  <img src="docs/readme-pics/mobile-answer-agent-simulator-to-split-tmux.gif" alt="Answering an agent from the ClawTab mobile app" width="600" />
</p>

The daemon owns the tmux sessions and connects to the Rust/Axum relay. Web and mobile clients receive terminal output and send input through the relay back to the original pane.

```text
tmux pane <-> ClawTab daemon <-> Relay server <-> Web or mobile client
```

## How It Works

1. **Start in tmux** - Run an agent normally or launch a configured job through `cwtctl`, `cwttui`, the desktop app, Telegram, or cron.
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
