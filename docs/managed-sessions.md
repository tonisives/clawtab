# Sessions without tmux

ClawTab 0.6 adds managed terminal sessions. Start Codex, Claude Code, OpenCode, or a shell from a normal terminal and open the same session from ClawTab Remote. Tmux is optional for this workflow.

## Start an agent

Install ClawTab 0.6 or newer and the provider CLI you want to use. On macOS, update with `brew upgrade --cask tonisives/tap/clawtab`. Linux and Windows host packages are on the [release page](https://github.com/tonisives/clawtab/releases/tag/v0.6.0); see [platform installation](platform-builds.md).

From your project directory:

```sh
cwtctl session start -- codex
```

Replace `codex` with `claude` or `opencode` to use another provider. ClawTab starts the agent in the current directory. A separate owner process keeps its terminal alive when you close the viewer or restart the ClawTab app or daemon.

To see it remotely, keep the host daemon running and pair the host with your ClawTab account. Run `cwtctl setup` and approve the code in **Machines > Add machine**, then open the host in [web Remote](https://remote.clawtab.cc) or the mobile app. See [remote machine setup](remote-machines.md) for pairing details.

Managed agents appear beside tmux agents. A shell icon identifies their terminal, and Codex titles update as the conversation name becomes available. The local viewer uses a small `⫻` marker near the top right instead of reserving a footer row. It turns cyan while a remote client controls the terminal.

## Detach and reconnect

Press **Ctrl+]**, then **d** to detach. The agent keeps running. List your sessions, then copy the ID into the attach command:

```sh
cwtctl session list
cwtctl session attach managed:<session-id>
```

Closing the originating terminal also leaves the agent running by default. Use `--close-with-terminal` to stop it when that terminal closes, or `--keep-running` to override your global preference. Explicit detach keeps the agent running with either policy.

For an agent that starts in the background:

```sh
cwtctl session start --detached -- codex
```

Inspect captured output or stop a session explicitly:

```sh
cwtctl session capture managed:<session-id> --history
cwtctl session stop managed:<session-id>
```

## Switch between local and remote control

Taking control from a phone resizes the terminal to that screen. The first local key reclaims control and restores the local dimensions; that key is consumed. Watching clients cannot type or resize the terminal until they take control.

The owner retains the terminal screen and up to 10,000 history rows. Use **History** in the app or `session capture --history` to inspect them.

## Choose a default and recover interrupted work

Choose a backend in **Settings > Runtime**, or set `terminal_backend: managed` in an individual job's YAML. Existing Unix installations keep tmux as their default. Windows uses managed sessions.

A computer reboot or owner crash interrupts the process. `cwtctl session resume <id>` can resume a saved provider conversation when its identity is available. Enable the provider's ClawTab hooks to retain that identity. Resume does not automatically replay the original prompt.

ClawTab cannot adopt an arbitrary agent that is already running outside it. Start that agent through `cwtctl session start`. Tmux layouts, copy mode, and conversation Move still require the tmux backend.

Sessions launched by an older CLI keep their original owner process after an update. Reattach with the updated CLI for the new viewer marker; launch a new session to pick up changes to title tracking in the owner.
