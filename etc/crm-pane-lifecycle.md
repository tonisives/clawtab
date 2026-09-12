# Guarded CRM pane completion

The September 12 CRM X proof found a startup race: the daemon finalized a
running agent when tmux briefly reported a shell. It released the emulator
lease and published success with no result before the agent had begun research.

For `crm_social_research`, the launcher now sets pane-local `remain-on-exit`
before sending the agent command. The monitor uses tmux's process-death and
exit-status fields, not its foreground-command name. A startup shell and an
idle interactive agent are still alive. An inventory/capture failure is unknown
and does not release the lease. A successful inventory proving the exact pane
missing finishes as failure with an unknown exit code, never invented exit 0.

On actual exit, the monitor retains output, reads the structured result once,
records the real exit code, reports the result, and then drops its lease. A
guarded run needs both exit 0 and a valid result file to be successful. Existing
unguarded jobs keep their previous completion heuristic. The agent launch
wrapper also uses a task-specific exit-code variable; zsh's `status` is read-only
and prevented the old wrapper from cleaning its prompt and exiting normally.

The opt-in local test creates one temporary shell pane beside an explicitly
selected parent. It tests startup, true failed exit, retained output and an
in-memory resource lease through collection, followed by cooldown. It does not
use an agent, emulator, production history, real resource budget or secrets:

```sh
CLAWTAB_LIFECYCLE_TEST_PARENT_PANE=<your-pane-id> \
  cargo test --no-default-features --lib -j4 real_guarded_poller -- --ignored
```

This is not a durable cross-process resource lock or a daemon-owned deadline.
Do not restart/rebuild the daemon while a supervised collector is active. Keep
CRM's exact-run supervisor and an operator present; its 20-minute deadline and
result-policy/cleanup checks still apply. An interactive agent that has written
its result must exit normally before collection. Never grant approvals, disable
the sandbox, or label an idle TUI as exited to force success.

Deployment is local via the existing development watcher after a tested local
merge. This patch does not release relay, triggers, frontend, journal or cloud
services and must not be used to push unrelated local-ahead commits.
