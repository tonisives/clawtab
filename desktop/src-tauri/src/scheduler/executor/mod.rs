// Catch over-long / over-complex functions early. Thresholds live in
// clippy.toml. Scoped to this module so introducing the lints doesn't require
// fixing every legacy function across the crate in this PR.
#![warn(clippy::too_many_lines, clippy::cognitive_complexity)]

mod binary;
pub mod binary_runtime;
mod claude;
mod finalize;
mod folder;
mod notification;
mod params;
mod tmux_spawn;

use std::collections::{HashMap, HashSet};

use chrono::Utc;

use crate::config::jobs::{Job, JobStatus, JobType};
use crate::config::settings::AppSettings;
use crate::history::RunRecord;
use crate::job_context::JobContext;

use binary::execute_binary_job;
use claude::execute_claude_job;
use finalize::{attach_monitor, finalize_run, RunCtx, RunOutcome};
use folder::execute_folder_job;
use params::apply_param_defaults;

/// Result from a tmux job: the tmux session and pane ID for monitoring.
pub(super) struct TmuxHandle {
    pub(super) tmux_session: String,
    pub(super) pane_id: String,
}

/// Per-call options for `execute_job`. Use `ExecuteOpts::default()` for a
/// basic fire-and-forget run.
#[derive(Default)]
pub struct ExecuteOpts {
    /// Explicit run id supplied by a local CLI caller. Other callers leave
    /// this unset and receive a generated UUID (or their trigger id).
    pub run_id: Option<String>,
    /// Enable auto-yes tracking for this run's tmux pane.
    pub use_auto_yes: bool,
    /// Channel to notify the caller of the spawned pane/session ids.
    pub pane_tx: Option<tokio::sync::oneshot::Sender<(String, String)>>,
    /// External trigger id. When set, used as run_id and threaded into
    /// the spawned process via CLAWTAB_RESULT_FILE so the job can write a
    /// structured result. On finish the monitor reads that file and pushes
    /// a TriggerResult to the relay.
    pub trigger_id: Option<String>,
}

pub(super) fn resolve_agent_model(
    job: &Job,
    settings: &AppSettings,
    provider: crate::agent_session::ProcessProvider,
) -> Option<String> {
    if let Some(model) = job.agent_model.clone() {
        return Some(model);
    }
    if job.agent_provider.is_none() || provider == settings.default_provider {
        return settings.default_model.clone();
    }
    None
}

/// Generate a unique tmux window name for a single agent spawn.
///
/// Each spawn gets its own window so clawtab can resize it independently -
/// splits in a shared window force all panes to the same geometry, which
/// breaks per-tab sizing in the viewer.
pub(super) fn project_window_name(job: &Job) -> String {
    let project = match job.slug.split_once('/') {
        Some((prefix, _)) if !prefix.is_empty() => prefix,
        _ => &job.name,
    };
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("cwt-{}-{}", project, suffix)
}

pub async fn execute_job(
    job: &Job,
    ctx: &JobContext,
    trigger: &str,
    params: &HashMap<String, String>,
    opts: ExecuteOpts,
) {
    let merged_params = merge_param_defaults(job, params);
    let params: &HashMap<String, String> = merged_params.as_ref().unwrap_or(params);

    let mut pane_tx = opts.pane_tx;
    let trigger_id = opts.trigger_id;

    let run_id = opts
        .run_id
        .clone()
        .or_else(|| trigger_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let started_at = Utc::now().to_rfc3339();

    let result_file = prepare_result_file(job, &run_id, trigger_id.as_deref());
    let stream_log_path = prepare_stream_log(job, &run_id);

    mark_running(job, ctx, &run_id, &started_at);
    insert_history_and_prune(
        job,
        ctx,
        &run_id,
        &started_at,
        trigger,
        stream_log_path.as_deref(),
    );
    let keep_existing = job.max_history.saturating_sub(1) as usize;
    enforce_live_pane_retention(job, ctx, keep_existing);

    log::info!("[{}] Starting job '{}' ({})", run_id, job.name, trigger);

    let result = dispatch_job(
        job,
        ctx,
        &run_id,
        &started_at,
        params,
        result_file.as_deref(),
        stream_log_path.as_deref(),
    )
    .await;

    let telegram_config = {
        let s = ctx.settings.lock();
        s.telegram.clone()
    };

    let rc = RunCtx {
        job,
        ctx,
        run_id: &run_id,
        started_at: &started_at,
        trigger_id: &trigger_id,
        result_file: &result_file,
        telegram_config: &telegram_config,
    };

    handle_result(&rc, result, &mut pane_tx, opts.use_auto_yes).await;
}

/// Fill missing param entries from each JobParam's declared default. Returns
/// None when nothing needed merging so the caller can avoid an allocation.
fn merge_param_defaults(
    job: &Job,
    params: &HashMap<String, String>,
) -> Option<HashMap<String, String>> {
    let needs_merge = job
        .params
        .iter()
        .any(|p| p.value.is_some() && !params.contains_key(&p.name));
    if !needs_merge {
        return None;
    }
    let mut m = params.clone();
    apply_param_defaults(job, &mut m);
    Some(m)
}

/// Compute the per-run result file path and create its parent dir. Only set
/// when the run was started by an external trigger (so the child can write a
/// structured result the monitor can push back to the relay).
fn prepare_result_file(
    job: &Job,
    run_id: &str,
    trigger_id: Option<&str>,
) -> Option<std::path::PathBuf> {
    let path = trigger_id.and_then(|_| {
        crate::config::config_dir().map(|d| {
            if job.group == "agent" {
                crate::agent::agent_logs_dir(&crate::agent::agent_group_from_slug(&job.slug))
                    .join(format!("{}.json", run_id))
            } else {
                d.join("jobs")
                    .join(&job.slug)
                    .join("logs")
                    .join(format!("{}.json", run_id))
            }
        })
    })?;
    ensure_parent_dir(&path, "result");
    Some(path)
}

/// Compute the streaming log path for binary jobs and create its parent dir.
/// tmux jobs return None (their output lives in tmux's scrollback / capture).
fn prepare_stream_log(job: &Job, run_id: &str) -> Option<std::path::PathBuf> {
    if !matches!(job.job_type, JobType::Binary) {
        return None;
    }
    let path = crate::config::jobs::JobsConfig::jobs_dir_public().map(|d| {
        d.join(&job.slug)
            .join("logs")
            .join(format!("{}.log", run_id))
    })?;
    ensure_parent_dir(&path, "log");
    Some(path)
}

fn ensure_parent_dir(path: &std::path::Path, kind: &str) {
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!(
                "Failed to pre-create {} dir {}: {}",
                kind,
                parent.display(),
                e
            );
        }
    }
}

/// Mark the job as Running and push the status update. pane_id stays None
/// here; tmux jobs fill it in once the pane is created.
fn mark_running(job: &Job, ctx: &JobContext, run_id: &str, started_at: &str) {
    let new_status = JobStatus::Running {
        run_id: run_id.to_string(),
        started_at: started_at.to_string(),
        pane_id: None,
        tmux_session: None,
    };
    let mut status = ctx.job_status.lock();
    status.insert(job.slug.clone(), new_status.clone());
    drop(status);
    crate::relay::push_status_update(&ctx.relay, &job.slug, &new_status);
}

/// Insert the new run record, then prune the per-job history to max_history,
/// killing any tmux panes that the prune removed.
fn insert_history_and_prune(
    job: &Job,
    ctx: &JobContext,
    run_id: &str,
    started_at: &str,
    trigger: &str,
    stream_log_path: Option<&std::path::Path>,
) {
    let record = RunRecord {
        id: run_id.to_string(),
        job_id: job.slug.clone(),
        started_at: started_at.to_string(),
        finished_at: None,
        exit_code: None,
        trigger: trigger.to_string(),
        stdout: String::new(),
        stderr: String::new(),
        pane_id: None,
        log_path: stream_log_path.map(|p| p.to_string_lossy().into_owned()),
    };

    let h = ctx.history.lock();
    if let Err(e) = h.insert(&record) {
        log::error!("Failed to insert run record: {}", e);
    }
    match h.prune_job_to_limit(&job.slug, job.max_history) {
        Ok(pruned_panes) => {
            for pane_id in pruned_panes {
                close_pane_for_retention(pane_id);
            }
        }
        Err(e) => log::error!("Failed to prune job history for {}: {}", job.slug, e),
    }
}

pub(super) fn enforce_live_pane_retention(job: &Job, ctx: &JobContext, keep: usize) {
    let started_map = {
        let h = ctx.history.lock();
        h.pane_started_at_for_job(&job.slug).unwrap_or_default()
    };
    let panes = match crate::tmux::list_panes_by_slug(&job.slug) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Failed to list panes for slug {}: {}", job.slug, e);
            return;
        }
    };
    let mut seen = HashSet::new();
    let mut entries: Vec<(String, String, u64)> = panes
        .into_iter()
        .filter_map(|(pane_id, pane_pid)| {
            if !seen.insert(pane_id.clone()) {
                return None;
            }
            let started_at = started_map.get(&pane_id).cloned().unwrap_or_default();
            Some((pane_id, started_at, pane_pid))
        })
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.2.cmp(&a.2)));
    for (pane_id, _, _) in entries.into_iter().skip(keep) {
        close_pane_for_retention(pane_id);
    }
}

fn close_pane_for_retention(pane_id: String) {
    tokio::spawn(async move {
        if let Err(e) = crate::tmux::close_pane_gracefully(&pane_id).await {
            log::warn!("Failed to close retained pane {}: {}", pane_id, e);
        }
    });
}

/// Run the per-type executor and normalize its return shape so the caller can
/// match on a single result type regardless of whether the job spawned a pane.
async fn dispatch_job(
    job: &Job,
    ctx: &JobContext,
    run_id: &str,
    started_at: &str,
    params: &HashMap<String, String>,
    result_file: Option<&std::path::Path>,
    stream_log_path: Option<&std::path::Path>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    match job.job_type {
        JobType::Binary => execute_binary_job(
            job,
            run_id,
            started_at,
            &ctx.secrets,
            &ctx.settings,
            params,
            result_file,
            stream_log_path,
        )
        .await
        .map(|(code, out, err)| (code, out, err, None)),
        JobType::Claude => {
            execute_claude_job(job, &ctx.secrets, &ctx.settings, params, result_file).await
        }
        JobType::Job => {
            execute_folder_job(job, &ctx.secrets, &ctx.settings, params, result_file).await
        }
    }
}

/// Branch on the dispatcher's result: tmux jobs hand off to the monitor;
/// non-tmux jobs (and spawn errors) go straight through finalize_run.
async fn handle_result(
    rc: &RunCtx<'_>,
    result: Result<(Option<i32>, String, String, Option<TmuxHandle>), String>,
    pane_tx: &mut Option<tokio::sync::oneshot::Sender<(String, String)>>,
    use_auto_yes: bool,
) {
    match result {
        Ok((_, _, _, Some(handle))) => {
            // monitor owns finalization for tmux jobs; drop the unused output.
            attach_monitor(rc, handle, pane_tx, use_auto_yes);
        }
        Ok((exit_code, stdout, stderr, None)) => {
            let success = exit_code == Some(0);
            finalize_run(
                rc,
                RunOutcome {
                    success,
                    exit_code,
                    stdout: &stdout,
                    stderr: &stderr,
                    error: None,
                },
            )
            .await;
        }
        Err(e) => {
            finalize_run(
                rc,
                RunOutcome {
                    success: false,
                    exit_code: Some(-1),
                    stdout: "",
                    stderr: "",
                    error: Some(&e),
                },
            )
            .await;
        }
    }
}
