# Linux machines

ClawTab runs one `clawtab-daemon` per machine. The same daemon handles local IPC, schedules, agent discovery, plugins, questions, and the outbound connection to the shared relay. Installing a Linux host does not install a local relay, database, or second daemon. `cwtctl` is a command-line client; `clawtab-hook` is an event helper.

## Install and pair

The Linux release workflow produces x86_64 and arm64 packages for Ubuntu 22.04+ and Debian 12+. Install `tmux`, Git, Python 3, and a working user systemd manager. Install and authenticate the agent providers you want to use on the host; their credentials stay there.

Download `etc/download-linux.sh` from the release you intend to install, inspect it, then run it with that release tag:

```sh
sh download-linux.sh vX.Y.Z
~/.local/bin/cwtctl setup --name build-host --linger
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

## Validation

Tests cover machine routing with identical pane IDs, private new hosts, requester-only replies, guest access revocation, terminal control, stale execution IDs, duplicate question answers, durable launch claims, and Git-transfer integrity and traversal rejection. Linux headless tests and a daemon startup smoke check run in an isolated Debian arm64 container. CI builds both Linux architectures. Native device notifications and boot/logout behavior require checks on actual hosts/devices; the container does not run a systemd user manager.
