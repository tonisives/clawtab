mod binary;
mod claude;
mod finalize;
mod folder;
mod notification;
mod params;
mod tmux_spawn;

use std::collections::HashMap;

use chrono::Utc;

use crate::config::jobs::{Job, JobStatus, JobType};
use crate::config::settings::AppSettings;
use crate::history::RunRecord;
use crate::job_context::JobContext;

use binary::execute_binary_job;
use claude::execute_claude_job;
use finalize::{attach_monitor, finalize_run, RunOutcome};
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
    // Fill any missing param entries from each JobParam's declared default value
    // so cron-triggered runs (which pass an empty map) still get sensible values.
    let merged_params: Option<HashMap<String, String>> = if job
        .params
        .iter()
        .any(|p| p.value.is_some() && !params.contains_key(&p.name))
    {
        let mut m = params.clone();
        apply_param_defaults(job, &mut m);
        Some(m)
    } else {
        None
    };
    let params: &HashMap<String, String> = merged_params.as_ref().unwrap_or(params);

    let mut pane_tx = opts.pane_tx;
    let trigger_id = opts.trigger_id;

    let run_id = trigger_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let started_at = Utc::now().to_rfc3339();

    // Pre-compute the result file path so we can both inject it into the
    // child process env and read it back on finish. trigger_id-only feature.
    let result_file: Option<std::path::PathBuf> = trigger_id.as_ref().and_then(|_| {
        crate::config::config_dir().map(|d| {
            d.join("jobs")
                .join(&job.slug)
                .join("logs")
                .join(format!("{}.json", run_id))
        })
    });
    if let Some(ref p) = result_file {
        if let Some(parent) = p.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("Failed to pre-create result dir {}: {}", parent.display(), e);
            }
        }
    }

    // Mark as running (pane_id filled in later for tmux jobs)
    {
        let new_status = JobStatus::Running {
            run_id: run_id.clone(),
            started_at: started_at.clone(),
            pane_id: None,
            tmux_session: None,
        };
        let mut status = ctx.job_status.lock();
        status.insert(job.slug.clone(), new_status.clone());
        drop(status);
        crate::relay::push_status_update(&ctx.relay, &job.slug, &new_status);
    }

    // Pre-compute the streaming log path for binary jobs so it's persisted
    // on the row from the start. tmux jobs ignore this (their output lives
    // in tmux's scrollback / capture).
    let stream_log_path: Option<std::path::PathBuf> = if matches!(job.job_type, JobType::Binary) {
        crate::config::jobs::JobsConfig::jobs_dir_public().map(|d| {
            d.join(&job.slug)
                .join("logs")
                .join(format!("{}.log", run_id))
        })
    } else {
        None
    };
    if let Some(ref p) = stream_log_path {
        if let Some(parent) = p.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::warn!("Failed to pre-create log dir {}: {}", parent.display(), e);
            }
        }
    }

    let record = RunRecord {
        id: run_id.clone(),
        job_id: job.slug.clone(),
        started_at: started_at.clone(),
        finished_at: None,
        exit_code: None,
        trigger: trigger.to_string(),
        stdout: String::new(),
        stderr: String::new(),
        pane_id: None,
        log_path: stream_log_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
    };

    {
        let h = ctx.history.lock();
        if let Err(e) = h.insert(&record) {
            log::error!("Failed to insert run record: {}", e);
        }
        match h.prune_job_to_limit(&job.slug, job.max_history) {
            Ok(pruned_panes) => {
                for pane_id in pruned_panes {
                    if let Err(e) = crate::tmux::kill_pane(&pane_id) {
                        log::warn!("Failed to kill pruned pane {}: {}", pane_id, e);
                    }
                }
            }
            Err(e) => log::error!("Failed to prune job history for {}: {}", job.slug, e),
        }
    }

    // Also kill orphan tmux panes for this slug whose history rows were already
    // pruned in earlier runs but the panes remained alive (kill_on_end=false).
    // The new pane is about to spawn, so keep `max_history - 1` existing panes.
    // Order by history.started_at (authoritative); panes without a history row
    // are treated as oldest and killed first.
    if job.max_history > 0 {
        let keep = job.max_history.saturating_sub(1) as usize;
        let started_map = {
            let h = ctx.history.lock();
            h.pane_started_at_for_job(&job.slug).unwrap_or_default()
        };
        match crate::tmux::list_panes_by_slug(&job.slug) {
            Ok(panes) => {
                let mut with_ts: Vec<(String, String)> = panes
                    .into_iter()
                    .map(|(pid, _)| {
                        let ts = started_map.get(&pid).cloned().unwrap_or_default();
                        (pid, ts)
                    })
                    .collect();
                with_ts.sort_by(|a, b| b.1.cmp(&a.1));
                for (pane_id, _) in with_ts.into_iter().skip(keep) {
                    if let Err(e) = crate::tmux::kill_pane(&pane_id) {
                        log::warn!("Failed to kill orphan pane {}: {}", pane_id, e);
                    }
                }
            }
            Err(e) => log::warn!("Failed to list panes for slug {}: {}", job.slug, e),
        }
    }

    log::info!("[{}] Starting job '{}' ({})", run_id, job.name, trigger);

    let result: Result<(Option<i32>, String, String, Option<TmuxHandle>), String> =
        match job.job_type {
            JobType::Binary => execute_binary_job(
                job,
                &ctx.secrets,
                &ctx.settings,
                params,
                result_file.as_deref(),
                stream_log_path.as_deref(),
            )
            .await
            .map(|(code, out, err)| (code, out, err, None)),
            JobType::Claude => {
                execute_claude_job(job, &ctx.secrets, &ctx.settings, params, result_file.as_deref())
                    .await
            }
            JobType::Job => {
                execute_folder_job(job, &ctx.secrets, &ctx.settings, params, result_file.as_deref())
                    .await
            }
        };

    let telegram_config = {
        let s = ctx.settings.lock();
        s.telegram.clone()
    };

    match result {
        Ok((exit_code, stdout, stderr, Some(handle))) => {
            attach_monitor(
                job,
                ctx,
                handle,
                &run_id,
                &started_at,
                &trigger_id,
                &result_file,
                &telegram_config,
                &mut pane_tx,
                opts.use_auto_yes,
            );
            // monitor owns finalization; ignore the unused outputs.
            let _ = (exit_code, stdout, stderr);
        }
        Ok((exit_code, stdout, stderr, None)) => {
            let success = matches!(exit_code, Some(0) | None);
            finalize_run(
                job,
                ctx,
                &run_id,
                &trigger_id,
                &result_file,
                &telegram_config,
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
                job,
                ctx,
                &run_id,
                &trigger_id,
                &result_file,
                &telegram_config,
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
