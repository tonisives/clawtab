![ClawTab Documentation](./docs-hero.png)

# ClawTab Documentation

ClawTab connects Claude Code, Codex, OpenCode, and Hermes in one workspace. A background daemon tracks every session, and the message bar, tmux plugin, CLI, desktop app, and phone and web apps all work with the same sessions. These pages cover each part in detail.

## Table of Contents

### Getting Started
- [Message bar](./messages.md): handle agent questions, approvals, updates, and replies
1. [Quick Start](./quick-start.md) -- Installation, setup wizard, first job
2. [Configuration](./configuration.md) -- Settings, job definitions, file locations

### Usage
3. [Job Types](./job-types.md) -- Binary, Claude, and Folder jobs
4. [Secrets](./secrets.md) -- Keychain and gopass integration
5. [Telegram](./telegram.md) -- Notifications and agent mode
6. [CLI & TUI](./cli-tui.md) -- Command-line and terminal UI
- [Tmux plugin](./tmux.md) -- Status markers, task titles, floating menu, keybindings
7. [Vim / Tmux Navigation](./vim-tmux-navigation.md) -- Share Ctrl-hjkl across vim, tmux, and ClawTab panes
8. [Local Executable Plugins](./agent-plugins.md) -- Add trusted local actions for agent panes

### Remote Access
9. [Remote Access](./remote.md) -- Control jobs from your phone via relay server
10. [Workspace Sharing](./sharing.md) -- Share your workspace with colleagues
11. [Self-Hosted Deployment](./deploy.md) -- Run your own relay, PostgreSQL, and frontend

- [Remote Machines](./remote-machines.md) -- Install Linux hosts, resolve account connection errors, and work across machines
- [Rented Boxes](./rented-boxes.md) -- Hetzner setup, provider authorization, billing, and deletion

### Reference
12. [Architecture](./architecture.md) -- System design, execution flow, IPC
13. [Project Layout](./project-layout.md) -- Repository structure (relay, mobile, protocol)
14. [File Reference](./file-reference.md) -- Config paths, schemas, log locations

- [Sessions without tmux](managed-sessions.md) -- Start, detach, reconnect, and control a managed terminal
- [Enhanced notifications](../desktop/docs/enhanced-notifications.md) -- Daemon cards, decisions, and custom layouts
- [Platform installation](platform-builds.md) -- macOS, Linux, and Windows host packages
- [Release notes](release-notes.md) -- Managed sessions, Windows hosting, and other changes
