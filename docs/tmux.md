# Tmux plugin

The bundled tmux plugin shows agent status in your status bar, names panes after their task, and adds a floating menu for auto-yes, session forking, skill search, secret injection, and a terminal sidebar. It doesn't replace your theme.

<p align="center">
  <img src="https://cdn.clawtab.cc/assets/articles/daemon-tmux/tmux-agent-working.png?v=20260716" alt="Tmux status bar showing working and idle activity indicators across AI agent windows" width="1000" />
</p>

<p align="center"><em>You can see which windows are working, waiting, or idle before you switch to them.</em></p>

## Install

Add the plugin to `.tmux.conf`:

```sh
run-shell /path/to/clawtab/tmux-clawtab/clawtab.tmux
```

Then reload tmux:

```sh
tmux source-file ~/.tmux.conf
```

## Keybindings

| Key | Action |
|-----|--------|
| `prefix + E` | Open a floating ClawTab menu over the current pane |
| `prefix + y` | Toggle auto-yes for the current agent pane |
| `prefix + o` | Open the current pane in the ClawTab desktop app |
| `prefix + s` | Search skills and insert a skill command |
| `prefix + f` | Fork the current agent session into a new pane |
| `` prefix + ` `` | Open the ClawTab terminal sidebar |

All keys can be changed through tmux options.

## Floating menu

The menu has Home, Plugins, Secrets, and Skills tabs. Home shows provider usage, session start time, the first and latest queries, the session ID, and restore context. Plugins lists actions from your installed [local plugins](./agent-plugins.md) for the current pane; press Enter to run one. ClawTab ships no agent actions by default.

Each agent pane can have its own menu, and the rest of tmux stays interactive while it's open. Opening it again from the same agent focuses the existing one.

The menu covers 95% of its pane by default. To change the size, or go back to the old client-modal popup:

```tmux
set -g @clawtab-menu-size 85
# set -g @clawtab-menu-mode popup
```

Floating panes need tmux 3.7 or newer. Older versions fall back to the popup.

## Status markers

| Marker | Meaning |
|--------|---------|
| cyan `*` | Working |
| yellow `!` | Waiting for your answer |
| orange `!` | Alert (rate limit, quota, auth, connection, overload) |
| green `✓` | Idle |

Window tabs also show how long ago the agent last did something: `jn` under a minute, then `13m`, `2h`, or `3d`. The age is green under an hour, amber under a day, and red after that. Only agent events and new output reset it. Focus changes, spinner repaints, and layout changes don't.

Each pane shows its title, age, and state icon in the top border. Narrow panes shorten `2h ago` to `2h`. The labels come from the daemon's cached snapshot, so panes in one window can show different states without a CLI call on every redraw.

Alerts come from the latest error block in the terminal. They clear when work resumes or newer output replaces the error. Switching to a window focuses the pane that has a question or alert. Alerts also show up as desktop and remote notification cards with a button to open the session, and new ones send an iOS push if remote notifications are on.

## Task titles

ClawTab reads the session name that Codex, Claude Code, OpenCode, and Hermes generate, usually within five seconds, and shows it in ClawTab and the pane border. If a window has exactly one agent and tmux automatic naming is on, the window gets the name too. Windows with several agents keep their name. Once you rename a window yourself, ClawTab leaves it alone, and custom pane names are never overwritten.

## Missed hook recovery

Hooks update status immediately. If one is missed, the daemon catches up after startup and in slow recovery rounds: at least ten minutes apart, one session every five seconds, oldest "working" markers first. Sessions confirmed idle leave the queue until a new hook arrives. Unresolved ones back off to 20, 40, then 80 minutes.

Recovery reads provider records directly: transcript tails for Claude and Codex, read-only SQLite for Hermes, and OpenCode's local session-status API, with SQLite as a fallback. Database queries get 50 ms and API requests time out after 250 ms. Recovery never captures pane contents or runs provider commands, and it needs explicit evidence: a quiet terminal or low CPU doesn't count as done. Recovered states don't replay old completion messages.
