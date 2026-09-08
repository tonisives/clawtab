# Remote machines: Linux setup and account connection

Use the desktop **Machines** button to manage your Mac and paired Linux hosts. The host runs the agents and stores the repositories; desktop, web, and mobile connect to that host's terminal. This page covers machines you install yourself. [Rented boxes](https://clawtab.cc/docs#rented-boxes) are a separate, upcoming setup path.

## Before you start

- Use a ClawTab client and shared relay with machine support. The relay must be updated before pairing new hosts.
- Choose Ubuntu 22.04+ or Debian 12+ on x86_64 or arm64. For a normal server, use a working systemd user manager; containers use `--no-service` instead.
- Choose a [release with Linux assets](https://github.com/tonisives/clawtab/releases). Older macOS-only releases do not include Linux packages.
- Sign in to your existing ClawTab account. On desktop, use **Settings → Remote → Account access**. There is no separate Machines account.

ClawTab runs one `clawtab-daemon` per machine. The same daemon handles local IPC, schedules, agent discovery, plugins, questions, and the outbound connection to the shared relay. Installing a Linux host does not install a local relay, database, or second daemon. `cwtctl` is a command-line client; `clawtab-hook` is an event helper.

## Install and pair

The Linux release workflow produces x86_64 and arm64 packages for Ubuntu 22.04+ and Debian 12+. Install `tmux`, Git, Python 3, and a working user systemd manager. Install and authenticate the agent providers you want to use on the host; their credentials stay there.

On the Linux host, install prerequisites and prepare a workspace as the user who will own the agent processes:

```sh
sudo apt-get update
sudo apt-get install -y tmux git python3 curl ca-certificates
mkdir -p ~/workspace
```

Download `etc/download-linux.sh` from the same release tag you intend to install. Replace `vX.Y.Z` below with an actual tag containing Linux assets:

```sh
CLAWTAB_RELEASE=vX.Y.Z
curl --fail --location --proto '=https' --tlsv1.2 \
  "https://raw.githubusercontent.com/tonisives/clawtab/$CLAWTAB_RELEASE/etc/download-linux.sh" \
  -o download-linux.sh
less download-linux.sh
```

After inspecting the script, install and pair:

```sh
sh download-linux.sh "$CLAWTAB_RELEASE"
export PATH="$HOME/.local/bin:$PATH"
cwtctl setup --name build-host --linger
```

The downloader requires an explicit version, fetches the matching architecture and SHA-256 file over HTTPS, verifies the archive, then installs it. Release packages become available when the Linux release workflow completes for a tag. Add `~/.local/bin` to your shell's PATH.

`setup` displays a code valid for ten minutes. In the desktop or mobile app, open **Machines → Add machine**, enter the code, and approve it. The host saves its credential and enables the user service. `--linger` asks systemd to keep that service available after logout and at boot; the host may require administrator authorization. Omit it if your host already configures lingering. Use `--relay https://…` for a self-hosted relay. Replacing an existing pairing requires `--replace`.

```sh
cwtctl daemon status
cwtctl daemon logs
cwtctl daemon stop
cwtctl daemon restart
cwtctl daemon uninstall
```

Updates replace binaries atomically. Restart the daemon when ready to load an update. Existing tmux agents survive daemon restarts; agents are not recreated after a host reboot. Normal scheduled jobs continue to follow their schedules. Uninstalling the service leaves repositories, configuration, and tmux sessions intact.

Linux credentials are stored under `~/.config/clawtab/credentials`, with directory mode 0700 and file mode 0600. Local sockets live under `$XDG_RUNTIME_DIR/clawtab`, or a private per-user temporary directory when no runtime directory is available. IPC checks the connecting user's UID. macOS continues using Keychain and its existing daemon service.

## Verify account access and select a machine

Open **Machines** after approving the code. The panel shows **Machine list connected** with an online count. Your local computer is marked **This Mac**. Each card includes its platform and **Online** or **Offline** status. The selected card and active tab have separate indicators. Select the host explicitly before launching; the start button names the target machine.

Two credentials serve different purposes:

| Status | What it confirms | What it does not confirm |
| --- | --- | --- |
| Settings → Remote → This machine: Connected | This daemon has a working relay connection | The app's account session can still load or manage machines |
| Machine list connected | The app can connect to the account's machine list | Every listed host is online or has authenticated coding tools |
| Host card: Online | The host is connected | A provider CLI is installed and ready to run |

If the machine list shows an account error, choose **Open account settings**, sign in with your existing account under **Account access**, and return to Machines. Sign-in triggers a retry; **Retry connection** is also available. You do not need to remove the daemon's working pairing just to renew account access.

An empty tab explains the next step: connect your account, pair your first machine, or select an existing host. If several entries have the same name, compare **This Mac**, platform, online state, and the identifier shown for duplicate remote names. Repeated registrations can create stale entries; a shared name does not mean the records are the same machine. Remove only the registration you intend to revoke using **Access**.

**Remove Relay Configuration** under desktop Remote settings removes this machine's server registration before clearing its local settings. If the server removal fails, local pairing stays intact and the error is shown. Removing a machine you own revokes its ClawTab access; it does not erase files or cancel a VPS purchased independently from a hosting provider.

## Authorize tools and launch an agent

1. Select an online host and open **Agents**. Browse to its workspace and choose **shell** to start a terminal there.
2. Install the coding CLIs you plan to use and complete their supported login or API-key setup on that host. Follow each provider's current instructions. Desktop sign-in does not transfer provider credentials.
3. Confirm Git access from the host. Use its SSH keys or credential manager for private repositories, submodules, and LFS content.
4. Open **Models** and enable the model identifiers supported by the installed provider. This setting only controls the available choices.
5. In **Repositories**, clone a project, or use desktop **Transfers** to send existing local work. Return to **Agents**, choose the repository directory, provider/model, and prompt, then start on the named host.

If another client controls the terminal, use **Take control** before typing. To check tool installation without displaying credentials, use `command -v claude`, `command -v codex`, or `command -v opencode` for the provider you installed.

## Containers and Kubernetes

Build `etc/Dockerfile.machine` from the public repository root. The image includes one foreground daemon, tmux, Git, Git LFS, Python, and Node.js. Mount a persistent home directory at `/home/clawtab` owned by UID/GID 1000 and run one replica. Install and authenticate provider CLIs on that persistent home directory.

The entrypoint starts the daemon immediately, so local IPC and readiness work before pairing. In the running container, run `cwtctl setup --name k3s-agent --no-service`, then approve the code from **Machines → Add machine**. This saves the pairing without installing systemd; Kubernetes supervises the daemon. Setup reloads the running daemon and starts its relay connection after saving the pairing. Replacing an existing pairing requires a deliberate container restart to load the replacement credentials. `--no-service` and `--linger` are mutually exclusive.

For example, with a StatefulSet named `clawtab-machine` in namespace `clawtab`:

```sh
kubectl -n clawtab exec -it clawtab-machine-0 -- \
  cwtctl setup --name k3s-agent --no-service

# After approval, verify local daemon requests and inspect container logs.
kubectl -n clawtab exec clawtab-machine-0 -- cwtctl jobs list
kubectl -n clawtab logs clawtab-machine-0 --tail=100
```

A Ready pod confirms the daemon and local IPC are available, including before pairing. It does not confirm account approval or provider authentication. If the pod is Ready but the host is absent from Machines, complete setup and approve its code with a valid account session.

Persisting the home directory preserves repositories and credentials across container replacement. It does not preserve running tmux processes or agents. Schedule image updates after finishing active work. No inbound application port, service-account token, relay sidecar, or host mount is required.

On desktop, the labeled **Machines** navigation button opens a dedicated panel. Secrets, Skills, and Usage are under **Settings**. Machine management no longer occupies a strip above the main job list.

## Work across machines

The jobs and agents list combines accessible machines. Machine badges distinguish otherwise identical names, paths, and tmux pane numbers. Use the machine buttons to filter the list. The **Machine** selection in the expanded panel chooses the launch and management target; no remote host is selected automatically.

- **Agents:** browse a host directory, choose one of that host's enabled models, and start an agent or shell.
- **Jobs:** create scheduled jobs. Existing job views provide run, stop, pause, resume, edit, and delete operations on their owning machine.
- **Repositories:** inspect status and staged/unstaged diffs, clone a repository, or create a branch in a new `.worktrees` directory. Git authentication comes from the host.
- **Models:** configure model identifiers enabled on that host. Provider installation and authentication happen on the host.
- **Access:** explicitly grant or revoke access for existing workspace guests, or remove a machine. Workspace group restrictions still apply. New machines start private; migration preserves shares for machines that already existed.

Plugin packages are installed and approved on their host using `cwtctl plugin installed`, `plugin approve`, and `plugin revoke`. Terminal **Agent actions** expose the approved provider-specific actions and their parameter forms. Questions remain attached to the originating machine, including notification answers.

Multiple relay clients may watch a terminal. One client controls its input and dimensions. **Take control** transfers that lease; it is renewed while connected and expires after thirty seconds without renewal. Closing a view releases its subscription. Direct tmux sessions and existing local desktop terminals remain governed by tmux rather than the relay's viewer lease.

If a machine disconnects, commands fail explicitly instead of falling back to another host. Reconnecting refreshes the roster and machine snapshots. Execution identities prevent delayed commands from targeting a recycled pane.

## Send and retrieve changes

Desktop **Transfers** supports explicit copies in either direction. Choose the local repository, the remote repository or destination path, and any additional individual files. Preview the snapshot before confirming.

A snapshot contains the Git history reachable from HEAD, including unpublished commits, staged and unstaged binary patches, and the explicitly selected files. Sensitive working files such as `.env`, private keys, and credential directories are excluded from automatic working-change capture. Explicit selection can include them. Previously committed files remain in Git history and are included; inspect the preview and repository history accordingly.

The receiver creates a detached `.worktrees/transfer-<operation-id>` checkout. It does not overwrite an existing checkout. Staged and unstaged changes retain their index distinction. Submodules and LFS content are materialized using host credentials; missing credentials or tools produce an incomplete-worktree error with its path for inspection.

Chunks use a separate client relay connection, fixed 256 KiB blocks, offsets, duplicate-chunk checks, and a final SHA-256 check. The default archive and expanded-size limit is 1 GiB. Retrying the transfer button after a connection failure resumes the same prepared transfer while the panel remains open. Cancellation invalidates that transfer ID. Transfer data expires after 24 hours and is removed when accessed after expiry. Transfers copy repository state; they do not migrate running conversations or continuously synchronize files.

## Routing and operation safety

The additive `/v2/ws` protocol requires a machine ID and request ID. The relay assigns the response's machine identity from the authenticated host connection. Request replies go only to the originating client; broadcasts and cached lists are filtered using current machine grants. Revocation closes client connections and forces authorization to be checked again.

Queues, frames, and pending requests are bounded. A slow client disconnects and receives fresh snapshots on reconnect. Legacy clients can issue commands only when their configured access resolves unambiguously to one machine and its owner has one configured host.

Launches and repository mutations record operation IDs on the host. Repeating an ID cannot start another launch, and a completed acknowledgement can be replayed. If a daemon exits between starting an operation and saving its result, **Check operation** reports pending or interrupted state; inspect that machine before creating a new operation.

Connections use TLS with the existing relay trust model. The relay can read terminal content and transfer payloads; this release does not add end-to-end encryption. Repository and provider credentials stay on the host unless the user explicitly includes credential files in a transfer.

## Rollout

Deploy the relay and its database migration before shipping the updated desktop/mobile clients or pairing Linux hosts. New clients require the machine API and `/v2/ws`; the installed shared relay is the only relay used in normal operation. Local integration relays are disposable test processes and are not installed as services. Publish Linux assets through the release workflow, then install and pair each host.

## Validation

Tests cover machine routing with identical pane IDs, private new hosts, requester-only replies, guest access revocation, terminal control, stale execution IDs, duplicate question answers, durable launch claims, and Git-transfer integrity and traversal rejection. Linux headless tests and a daemon startup smoke check run in an isolated Debian arm64 container. CI builds both Linux architectures. Native device notifications and boot/logout behavior require checks on actual hosts/devices; the container does not run a systemd user manager.
