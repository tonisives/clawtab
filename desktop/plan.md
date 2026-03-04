# Use `slug` as the unique job identifier everywhere

## Problem

`job.name` is used as the primary key throughout the system (status HashMap, log fetching, run history, actions), but it's not unique across projects. Two jobs in different projects (e.g., `defi-jobs/seo-improve` and `tskr/seo-improve`) share the same `name`, causing collisions.

`slug` is already unique (`project/job-name` format with counter dedup) and is the right identifier.

## Approach

Change the internal identifier from `name` to `slug` in the backend status HashMap, all backend commands, the frontend transport calls, and shared hooks/components. The `name` field remains as the display name only.

## Changes

### Backend (Rust)

**1. `scheduler/executor.rs`** - Use `job.slug` instead of `job.name` for:
  - `status.insert(...)` keys
  - `relay::push_status_update(...)` name param
  - `relay::push_log_chunk(...)` name param
  - `relay::push_job_notification(...)` name param
  - `RunRecord.job_name` field (stores slug now)

**2. `scheduler/monitor.rs`** - Use `params.slug` instead of `params.job_name` for:
  - `status.insert(...)` key (line 341)
  - `relay::push_status_update(...)` (line 343)
  - `relay::push_log_chunk(...)` (line 192)
  - `relay::push_job_notification(...)` (lines 62, 363)
  - Telegram messages can keep `job_name` for display

**3. `scheduler/reattach.rs`** - Use `job.slug` instead of `job.name` for:
  - `status.get(...)` check (line 114)
  - `status.insert(...)` (line 133-134)
  - `RunRecord.job_name` (line 149)
  - `MonitorParams.job_name` stays as display name

**4. `commands/jobs.rs`** - Change all commands to accept/find by slug:
  - `toggle_job`: find by `j.slug == name`
  - `run_job_now`: find by `j.slug == name`
  - `pause_job`: status key is now slug
  - `resume_job`: status key is now slug
  - `stop_job`: status key is now slug
  - `restart_job`: find by `j.slug == name`
  - `delete_job`: find by `j.slug == name`

**5. `commands/status.rs`** - `get_running_job_logs` and `send_job_input`: status lookup now by slug

**6. `commands/tmux.rs`** - `focus_job_window`: find by `j.slug == name`

**7. `relay/handler.rs`** - `run_job`, `pause_job`, `resume_job`, `stop_job`: find by slug, use slug for status operations

**8. `relay/mod.rs`** - `push_full_state`: statuses HashMap is now keyed by slug (no code change needed, it just mirrors the in-memory map)

### Frontend

**9. `shared/components/JobDetailView.tsx`**:
  - Use `job.slug` for all transport calls (runJob, stopJob, pauseJob, resumeJob, restartJob, sendInput)
  - Move `OptionButtons` + `MessageInput` from outside the scroll to inside, right after Live Output section

**10. `shared/hooks/useJobDetail.ts`** and **`useLogBuffer.ts`** - No change needed; callers pass the identifier

**11. `desktop/components/JobsTab.tsx`**:
  - `useJobDetail(transport, job.slug)` and `useLogBuffer(transport, job.slug)`
  - `core.statuses[viewingJob.slug]`
  - `actions.toggleJob(viewingJob.slug)`, `actions.deleteJob(viewingJob.slug)`
  - `handleOpen(viewingJob.slug)`
  - `questions.find(q => q.matched_job === viewingJob.name)` - keep as name (matched from process CWD, not slug)

**12. `desktop/transport/tauriTransport.ts`** - `subscribeLogs` event listener: match `event.payload.name` (will now be slug from backend log-chunk emit)

### No changes needed
- `shared/transport.ts` - Interface uses generic string params
- `shared/hooks/useJobActions.ts` - Passthrough, callers pass slug
- `shared/hooks/useJobsCore.ts` - `statuses` dict comes from backend, already keyed by slug after backend change
- `remote/transport/wsTransport.ts` - Passthrough, protocol uses generic string "name" field

## Migration note
- History DB `job_name` column: existing records use old `name` values. New records will use `slug`. Old history entries won't match when filtering by slug, but they auto-prune after 30 days. Acceptable tradeoff.
