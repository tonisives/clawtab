# Moving a conversation

Move is available beside the machine name in desktop and native mobile terminal views, and in the tmux popup. Choose an owned machine, review readiness and transferred files, then confirm. The target chooser includes Add machine when no target is configured.

This first release supports Claude 2.1.296 and Codex 0.162.1. Codex must run with `--no-daemon`; moving a shared server could interrupt other conversations. Both machines need the matching CLI version, Git, tmux, Python 3, working ClawTab lifecycle hooks, and their own provider credentials. OpenCode is blocked because its interactive idle handoff has not been verified. Policy-bound and externally triggered runs are blocked because their resource restrictions and result routing are machine-local. Native mobile stores client keys in SecureStore; browser clients cannot enable Secure Move.

## Enrollment

Deploy the relay supporting `secure_peer` and the updated host and clients before enrolling. Existing machines retain their current behavior until secure commands are enabled.

1. Open Move to obtain the client's public identity and fingerprint.
2. Through each machine's local console or trusted SSH connection, run `cwtctl move identity`.
3. Verify each machine ID and fingerprint over that trusted connection. Pin the identity in the client's Move view. Enroll each machine's public identity on the other with `cwtctl move trust-machine <public-json-or-file> --fingerprint <sha256>`.
4. Verify and enroll the client identity on both machines with `cwtctl move trust-client <public-json-or-file> --fingerprint <sha256>`.
5. Run `cwtctl move enable` on both machines. This disables unsigned remote commands. Older clients will need an update and enrollment to control these machines.

Private identity keys stay in macOS Keychain, native mobile SecureStore, or owner-only host storage on Linux. Public identities may be displayed and exchanged. Never copy private keys or credential files during enrollment. Key changes require explicit revocation and renewed verification. Use `cwtctl move help` for revocation and recovery commands.

## Transfer and handoff

The daemon waits for the selected conversation to reach a verified idle boundary, freezes its process tree, and captures Git state and selected native conversation history. Noise IK channels authenticate pinned hosts and encrypt the payload across the relay. Signed client commands have an expiry and durable replay protection. Move requests and their responses are also encrypted between client and host.

The target imports into an isolated Git worktree, resumes the existing conversation without sending a new prompt, and proves its process, native conversation identity, directory, and idle state. Only then does the source retire its original processes. Target input remains locked until that retirement is confirmed. The target waits for the next user message and does not depend on the source remaining online afterward.

Job definitions and schedules remain on the source. Move transfers the current conversation; it does not migrate recurring jobs or their future runs.

Optional dependency setup runs as a separate target conversation after a separate confirmation. Required project secrets must already exist on the target. No secret container, provider credentials, global agent configuration, or global history database is synchronized. Automatic secret synchronization is deferred.

Ignored files, dependency directories, credential files, environment files, private keys, and known agent configuration directories are excluded from working-file transfer. Review the preview: committed Git history and conversation text can still contain sensitive content. Unsaved input drafts are not transferred. A conflicting native conversation already present on the target is rejected rather than overwritten; moving back to an old source may therefore require resolving that collision first.

Terminal output continues through the existing relay and is not end-to-end encrypted. Secure Move does not change the encryption of other existing application data flows.

## Recovery

Operations persist independently of the modal, client connection, and daemon restart. Before target activation, cancellation restores the source. After an uncertain activation, the source stays paused until the target is checked. The recovery view can explicitly stop the target and restore the source; it waits for a durable target abort barrier before restoring. If the source has already retired, it cannot be restored through this action.

Source restoration is recorded before processes resume. If interrupted, recovery finishes restoration instead of retrying the old transfer. A durable target commit confirms a successful handoff even when its acknowledgement was lost and the remote has started another turn.

`cwtctl move status <operation-id>` inspects an operation; `check` reconciles the remote handoff. `rollback <operation-id> --confirm-stop-target` explicitly requests target shutdown and source restoration. Do not manually unfreeze a source while its target state is uncertain.

## Validation scope

Automated coverage includes command authentication and replay protection, Noise channel tampering and replay, native session adapters, Git working-state transfer, and relay ownership checks. Desktop and mobile type checks and desktop production build are required. A live paired-machine handoff and physical iOS/Android acceptance remain release checks; the implementation has not received an independent cryptographic security audit.
