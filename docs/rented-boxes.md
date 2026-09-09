# Rented boxes: setup preview

**Status: upcoming, September 9, 2026.** Hetzner rentals are under implementation. Purchases remain disabled pending provider configuration and end-to-end validation. The steps and policies below describe the planned first version; they are not a claim that checkout is available today. To connect a host now, follow [remote machine setup](https://clawtab.cc/docs#remote-machines).

A rented box is a Linux server prepared by ClawTab and attached to your account. It is intended to appear alongside your other machines and use the existing terminal, repository, job, and access controls. Your agent processes and repositories live on that server.

## Planned prerequisites

- A signed-in account with an active paid ClawTab subscription.
- Desktop or web for purchasing. iOS is intended to access existing rentals without offering checkout.
- Your own coding-tool subscriptions or API credentials. Server rental does not include AI usage.
- Git access for any private repositories you will clone.
- Optionally, an SSH **public** key for direct administration. Do not submit a private key.

## Planned purchase and setup

1. Open **Machines → Rent a box** on desktop or web when purchases become available.
2. Choose a name, size, and region. The first version targets x86 shared-CPU boxes with 4 GB or 8 GB RAM. Review the actual CPU, disk, included outgoing traffic, region, and monthly price shown in the quote. A timezone-based region suggestion is approximate; confirm the location you want.
3. Add an SSH public key if you want SSH access. Review the deletion and backup terms before paying.
4. Complete checkout. Provisioning starts only after the initial payment is verified. Returning from checkout alone does not mean the server is ready.
5. Wait for provisioning to finish and the machine to connect. Enrollment is intended to happen automatically, without running `cwtctl setup` or entering a pairing code.
6. Select the box and open its terminal. Authorize your coding tools, prepare a repository, and launch your first agent as described below.

Exact prices and available regions come from the catalog. The plan does not silently substitute a different region after payment. A failed or timed-out setup is intended to trigger resource cleanup, rental subscription cancellation, and a full initial-payment refund.

## What is prepared on the box

The planned image includes ClawTab's daemon, CLI, hooks and plugins, tmux, Git, Python, Node, Claude Code, Codex, and OpenCode. It configures service startup, a workspace directory, and agent discovery. A normal Linux user has sudo; password and root SSH login are disabled.

Installation is separate from authorization. A preinstalled CLI still needs your account login or API credentials. ClawTab's own sign-in authorizes machine access; it does not log you into Claude Code, Codex, OpenCode, or your Git host.

## Authorize providers and prepare work

Once the box is online, open its terminal and use the guided login action for your chosen provider. Complete that tool's supported headless authorization flow with your own account. Login methods can change; use the actions and provider guidance shipped with the released setup instead of copying an unverified command from a preview.

You can check whether the planned tools are on the shell's PATH without displaying credentials:

```sh
command -v claude
command -v codex
command -v opencode
command -v git
command -v tmux
```

Then prepare a repository:

1. Configure Git authentication on the box. A private repository needs credentials there, including access to any submodules or Git LFS objects.
2. Use **Repositories → Clone**, or send a snapshot with desktop **Transfers**. A transfer creates a separate worktree; it does not replace an existing checkout or move a running agent conversation.
3. Select enabled model identifiers under **Models**. Return to **Agents**, choose the repository directory and model, enter a prompt, and check the host named on the start button.
4. Open the agent from desktop, web, or iOS. Use **Take control** when another relay client holds terminal input control.

Provider and Git credentials remain on the host unless you explicitly transfer credential files. Connections use TLS, but ClawTab's relay can read terminal and transfer payloads. This feature does not introduce end-to-end encryption.

## Planned billing and deletion rules

Each box has a separate monthly subscription paid in advance. The planned price is provider cost, including required IPv4 and other mandatory provider charges, multiplied by 1.20. Applicable taxes are shown before payment. Your base ClawTab subscription and AI usage remain separate. The quote is retained through the purchased period; future price increases require advance notice.

| Event | Planned result |
| --- | --- |
| Successful renewal | Extend the box's paid period. |
| Unpaid renewal | Start a ten-day recovery deadline at the renewal's due time. Display the exact deletion time and send notices at failure and days 3, 7, and 9. |
| Payment recovered before deletion begins | Reconcile payment and retain the box. |
| Still unpaid at the ten-day deadline | Reconcile payment, revoke access, stop future collection, and permanently delete the server and associated billable resources. |
| Payment arrives after deletion begins | Refund the late payment rather than recreate the box. |
| Cancel renewal | Retain access until the current paid period ends, then delete. The failed-payment grace period does not extend voluntary cancellation. |
| Confirm immediate deletion | Delete immediately, without an automatic prorated refund. |
| Base ClawTab subscription expires | Preserve the box's already-paid period but disable rental renewal. Restoring the base subscription before deletion restores renewal. |

Use the rental's billing and deletion controls for a rented server. Removing a machine entry is not a substitute for confirming the rental lifecycle has ended. [Hetzner bills servers until deletion, even when powered off](https://docs.hetzner.com/cloud/billing/faq/), and retained Primary IPv4 addresses can continue to incur charges separately.

## Backups, traffic, and limits

Keep backups outside the box. The first version does not include managed backups, paid snapshots, resizing, other hosting providers, or bundled AI usage. Deletion is permanent. Closing the client leaves agents running, but rebooting the server ends running agents; their conversations are not automatically recreated.

The planned initial limit is three boxes per customer. Purchases can also be unavailable when service capacity is exhausted.

The traffic policy plans a warning at 75% of included outgoing traffic and a provider-side networking restriction at 90%, with restoration at the next provider traffic-period reset. Usage checks are planned every five minutes, so enforcement cannot guarantee zero overshoot. Networking restrictions can interrupt relay and terminal access. Review the released quote and traffic policy before relying on a box for large transfers.

## If setup does not progress

| Symptom | Check |
| --- | --- |
| Rent a box is unavailable | Rentals are not enabled yet, or purchasing eligibility/capacity is unavailable. Use an owned Linux host in the meantime. |
| Checkout completed, box still provisioning | Wait for payment verification and setup status. Avoid placing a second order just to retry the first. |
| Machine list has an account error | Renew the existing account session under desktop Settings → Remote → Account access, then retry. |
| Box is online, provider cannot run | Confirm the CLI is installed and authorized on that box and the selected model is supported. |
| Terminal is visible but does not accept input | Check whether another client holds control and use Take control. |
| Payment recovery deadline is shown | Recover payment before the exact deadline and copy out work you need to retain. Do not assume stopping the machine cancels billing. |

These troubleshooting steps describe the intended flow. Purchase availability and final operational behavior must be verified against the released implementation.
