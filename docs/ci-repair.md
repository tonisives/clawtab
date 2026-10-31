# Automatic CI repair

`Repair CI failure` sends failed or timed-out main-branch push runs to the local
ClawTab job `clawtab/ci-repair`. It observes CI, Managed terminals, Linux agent
host, Android Google Play build, and Release. Pull requests, forks, obsolete
commits, and failures of the repair workflow cannot start a repair.

The dispatcher uses the dedicated Actions secret `CLAWTAB_CI_REPAIR_TOKEN` and
variable `CLAWTAB_CI_REPAIR_DEVICE_ID`. Requests share an idempotency key per
commit. A failure on a commit containing `[clawtab-ci-repair]` stops automatic
repair until someone investigates or pushes another change.

The installed job copies `etc/clawtab/ci-repair/job.{yaml,md}` into
`~/.config/clawtab/jobs/clawtab/ci-repair/`. It has no schedule. It runs the
stable checkout's `scripts/run-ci-repair.py` in a background tmux job. Codex runs
with automatic approval review and follows the workspace AGENTS.md, including
the shared build worker. Repairs use worktrees, verify changes, merge locally,
and push without force. The wrapper serializes repairs with
`public/.worktrees/ci-repair.lock` and saves results and session checkpoints in
`public/.worktrees/ci-repair-state`. Inspect running jobs before clearing a lock.

`cwt jobs restart clawtab/ci-repair` continues the last interrupted repair.
Model-capacity errors resume the same session after 30 and 60 seconds; other
errors retain the checkpoint and stop. Completed requests return saved results.

Use manual dispatch with `failed_run_id` and `dry_run: true` to check a real
failure without launching a repair. Smoke delivery uses job parameter
`smoke=true`; it starts Codex and returns a result without changing files.
Disable the workflow to pause dispatches. Revoke the dedicated token and remove
the Actions secret to remove access. If the Mac is offline, inspect the failed
trigger before retrying: the API reuses terminal results for the same key.

Validate changes with `python3 scripts/test-trigger-ci-repair.py` and
`actionlint .github/workflows/ci-repair.yml`.
