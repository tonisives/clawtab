# ClawTab 0.6.2: the message bar

Agent questions, permission prompts, updates, and completion messages now come together in one macOS message bar. Reply from the card, read recent output in Details, or open the originating session. The daemon owns the bar, so the desktop app is optional.

- Focus the bar with Ctrl+Option+W. Browse cards with h/l, use keyboard hints, and send replies with Command+Enter.
- Keep replies and drafts while moving between cards. New messages queue behind the card being read; failed actions return with their error and draft intact.
- Search Pending and History, group messages by conversation, dismiss a selection, or ignore a noisy agent.
- Read terminal output and attachments in an expanded, resizable card, with terminal colors and reflowing soft wraps.
- Continue through web and iOS message cards. Pending messages escalate to mobile after 60 seconds of Mac inactivity, or immediately when locked or asleep, with delivery configured.
- Keep a task checklist beside the queue, optionally linked to a Markdown note and agent progress.
- Send questions and choices from scripts with `cwt message send ... --wait`.

## CLI and installation

The CLI is now `cwt`, replacing the installed `cwtctl` executable. Update scripts and shell completion references. The desktop app keeps its `clawtab` launcher. macOS packages include the daemon-owned message bar; the separate desktop cask remains optional.

```sh
brew update
brew upgrade --cask tonisives/tap/clawtab
```

If you use the desktop app, also upgrade `tonisives/tap/clawtab-desktop`.

The macOS message bar requires macOS 12 or later. Web Remote is deployed separately. This host/desktop release does not publish an iPhone or Android store build.

[Message bar guide](https://clawtab.cc/docs#messages) · [Demo](https://cdn.clawtab.cc/assets/home/message-bar-hero-v12e-narrated.mp4) · [Full changelog](https://github.com/tonisives/clawtab/compare/v0.6.1...v0.6.2)

# ClawTab 0.6.1

The default macOS install now contains the headless daemon, `cwt`, agent hooks, and Zsh completion. Install the desktop app separately:

```sh
brew install --cask tonisives/tap/clawtab
brew install --cask tonisives/tap/clawtab-desktop
```

The desktop app is optional. The daemon keeps schedules, notifications, and Remote running on its own. Apple Silicon and Intel releases include signed and notarized host archives alongside the desktop DMGs.

The daemon installer now finds Homebrew's installed executable and records its path in launchd. If you are moving from the combined cask, stop the service with `cwt daemon stop`, reinstall `clawtab`, and run `cwt daemon install`. Add `clawtab-desktop` afterward to keep the GUI.

See the [macOS installation guide](https://clawtab.cc/docs#platform-builds).

# ClawTab 0.6.0

ClawTab can now keep coding agents running without tmux. Launch an agent from a regular shell, detach, and reconnect from your terminal, browser, or phone. This release also adds a native Windows host.

## Managed terminal sessions

```sh
cwt session start -- codex
```

- Run Codex, Claude Code, OpenCode, or a shell in a persistent terminal on macOS, Linux, or Windows.
- Close the terminal and keep the agent running, or choose `--close-with-terminal`. Press Ctrl+] then d to detach deliberately.
- List, attach, capture output, stop, and resume sessions with `cwt session` commands.
- Take control from Remote and return to the local terminal with a keypress. Terminal dimensions follow the controlling client.
- See generated Codex titles, a shell icon on Remote cards, and a small claw marker in the local viewer without losing a footer row.

See the [managed session guide](https://clawtab.cc/docs#managed-sessions) for setup, control, and recovery behavior. Existing Unix installations retain tmux as their default. Managed sessions survive app and daemon restarts; rebooting the computer interrupts the process.

## Native Windows host

The Windows x86_64 package includes the daemon, `cwt`, provider hooks, and a per-user installer. It uses ConPTY on Windows 10 1809 or newer, with no WSL or tmux requirement. Pair with `cwt setup` and start an agent from your project directory. Installer upgrades preserve already running managed sessions.

macOS downloads remain available for Apple Silicon and Intel. Linux host packages are available for x86_64 and ARM64. The desktop GUI remains a macOS app.

## Agent titles and scheduling

- Generated conversation names appear in ClawTab and tmux. Duplicate Codex names retain useful generated labels.
- `cwt jobs create` supports recurring and one-time schedules, description files or stdin, and provider/model selection.
- `cwt jobs edit <group>/<job>` opens job configuration in nvim. Saved changes reload automatically.
- Failed jobs can produce local macOS alerts while offline.
- Claude activity detection follows live terminal spinners and footers. Auto-yes avoids a deadlock during concurrent process discovery, and tmux activity indicators recover after server restarts.

## Opt-in conversation Move

Move adds an encrypted, verified handoff of a supported idle conversation and its Git working state between enrolled machines. It checks the target before retiring the source and preserves recovery state across interruptions.

This initial implementation is restricted to supported Claude and Codex versions on tmux. Codex requires `--no-daemon`; OpenCode, managed terminals, browser clients, and policy-bound or externally triggered runs are not supported. Read the [Move guide](https://clawtab.cc/docs#secure-move) for enrollment, version requirements, and validation limits. Terminal streaming continues to use the existing relay transport; Move does not make all Remote traffic end-to-end encrypted.

## Remote and mobile changes

- Terminal subscriptions recover after network interruptions.
- Agent details and machine settings use clearer navigation and more reliable controls.
- A read-only demo remains available when relay access is unavailable, with clearer subscription and connection status.
- Demo search and layout, submitted keyboards, and purchase restoration feedback received fixes.

Web Remote is deployed separately. Native mobile changes require the corresponding app update; this desktop and host release does not publish a new App Store or Google Play build.

## Update

On macOS:

```sh
brew upgrade --cask tonisives/tap/clawtab
```

Or download the matching installer or host archive from [v0.6.0](https://github.com/tonisives/clawtab/releases/tag/v0.6.0). Linux and Windows packages include SHA-256 checksum files. Follow the [platform installation guide](https://clawtab.cc/docs#platform-builds).

Existing managed sessions keep their original owner executable after an upgrade. Reattach with the new CLI for the compact marker; start a new session for the updated owner title tracking.

[Full changelog since v0.5.19](https://github.com/tonisives/clawtab/compare/v0.5.19...v0.6.0)
