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
#[cfg(unix)]
use std::io::Read;
use std::path::Path;

use chrono::Utc;
use clawtab_protocol::JobPolicy;

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
    /// Policy selected by an external trigger. The policy is re-applied at
    /// the executor boundary so a caller cannot bypass prompt/env controls.
    pub policy: Option<JobPolicy>,
    /// Admission lease for a named machine-local resource.
    pub resource_lease: Option<crate::resource_policy::ResourceLease>,
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

/// Older jobs may not have persisted an effort yet. Keep their behavior
/// consistent with the selector by using medium for every agent provider.
pub(super) fn resolve_agent_effort(
    provider: crate::agent_session::ProcessProvider,
    effort: Option<String>,
) -> Option<String> {
    effort.or_else(|| {
        (provider != crate::agent_session::ProcessProvider::Shell).then(|| "medium".to_string())
    })
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
    let suffix = Utc::now().format("%Y%m%d");
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
    let policy = opts.policy;
    let resource_lease =
        match validate_admission(job, ctx, trigger_id.as_deref(), policy, opts.resource_lease) {
            Ok(lease) => lease,
            Err(()) => return,
        };

    let run_id = opts
        .run_id
        .clone()
        .or_else(|| trigger_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let started_at = Utc::now().to_rfc3339();

    let result_file = prepare_result_file(job, trigger_id.as_deref());
    let stream_log_path = prepare_stream_log(job, &run_id);

    let mut resource_lease = resource_lease;
    if let Some(lease) = resource_lease.as_mut() {
        lease.commit();
    }

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

    let result = dispatch_job(DispatchOptions {
        job,
        ctx,
        run_id: &run_id,
        started_at: &started_at,
        params,
        result_file: result_file.as_deref(),
        stream_log_path: stream_log_path.as_deref(),
        policy,
    })
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

    handle_result(&rc, result, &mut pane_tx, opts.use_auto_yes, resource_lease).await;
}

fn reject_trigger(ctx: &JobContext, trigger_id: &str, message: &str) {
    crate::relay::push_trigger_result(
        &ctx.relay,
        trigger_id,
        crate::relay::TriggerResultPayload {
            status: "rejected".into(),
            exit_code: None,
            result: None,
            error: Some(message.to_string()),
            result_status: Some("not_requested".into()),
            retry_at: None,
        },
    );
}

fn validate_admission(
    job: &Job,
    ctx: &JobContext,
    trigger_id: Option<&str>,
    policy: Option<JobPolicy>,
    resource_lease: Option<crate::resource_policy::ResourceLease>,
) -> Result<Option<crate::resource_policy::ResourceLease>, ()> {
    if let Some(trigger_id) = trigger_id {
        if uuid::Uuid::parse_str(trigger_id).is_err() {
            reject_trigger(ctx, trigger_id, "trigger id is not a valid UUID");
            drop(resource_lease);
            return Err(());
        }
    }
    if policy.is_some() && resource_lease.is_none() {
        if let Some(trigger_id) = trigger_id {
            reject_trigger(ctx, trigger_id, "resource policy admission was not granted");
        }
        return Err(());
    }
    if policy.is_some() && matches!(job.job_type, JobType::Binary) {
        if let Some(trigger_id) = trigger_id {
            reject_trigger(
                ctx,
                trigger_id,
                "resource policy is not allowed for binary jobs",
            );
        }
        drop(resource_lease);
        return Err(());
    }
    Ok(resource_lease)
}

/// Structured result collection is deliberately limited to the executor's
/// own per-run path. No caller-supplied server path is ever opened here.
#[derive(Debug)]
pub(crate) struct CollectedResult {
    pub status: &'static str,
    pub value: Option<serde_json::Value>,
    pub error: Option<String>,
}

pub(crate) fn collect_result_file(path: Option<&Path>) -> CollectedResult {
    let Some(path) = path else {
        return CollectedResult {
            status: "not_requested",
            value: None,
            error: None,
        };
    };
    let contents = match read_result_file(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return CollectedResult {
                status: "missing",
                value: None,
                error: None,
            };
        }
        Err(error) => {
            return CollectedResult {
                status: "unreadable",
                value: None,
                error: Some(format!("structured result file could not be read: {error}")),
            };
        }
    };
    match serde_json::from_str(&contents) {
        Ok(value) => CollectedResult {
            status: "valid",
            value: Some(value),
            error: None,
        },
        Err(error) => CollectedResult {
            status: "invalid_json",
            value: None,
            error: Some(format!(
                "structured result file contains invalid JSON: {error}"
            )),
        },
    }
}

fn read_result_file(path: &Path) -> std::io::Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = std::fs::OpenOptions::new();
        file.read(true).custom_flags(libc::O_NOFOLLOW);
        let mut contents = String::new();
        file.open(path)?.read_to_string(&mut contents)?;
        Ok(contents)
    }

    #[cfg(not(unix))]
    {
        std::fs::read_to_string(path)
    }
}

pub(super) fn apply_policy_env(env_vars: &mut Vec<(String, String)>, policy: Option<JobPolicy>) {
    let Some(policy) = policy else {
        return;
    };
    for (key, value) in policy.environment() {
        env_vars.retain(|(existing_key, _)| existing_key != key);
        env_vars.push((key.to_string(), value.to_string()));
    }
}

pub(super) fn apply_policy_prompt(
    prompt: String,
    policy: Option<JobPolicy>,
    provider: crate::agent_session::ProcessProvider,
) -> String {
    if provider == crate::agent_session::ProcessProvider::Shell {
        return prompt;
    }
    match policy {
        Some(policy) => format!("{prompt}\n\n{}", policy.prompt_directive()),
        None => prompt,
    }
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
fn prepare_result_file(job: &Job, trigger_id: Option<&str>) -> Option<std::path::PathBuf> {
    let canonical_trigger_id = trigger_id.and_then(|id| uuid::Uuid::parse_str(id).ok())?;
    let path = trigger_id.and_then(|_| {
        crate::config::config_dir().map(|d| {
            if job.group == "agent" {
                crate::agent::agent_logs_dir(&crate::agent::agent_group_from_slug(&job.slug))
                    .join(format!("{}.json", canonical_trigger_id))
            } else {
                d.join("jobs")
                    .join(&job.slug)
                    .join("logs")
                    .join(format!("{}.json", canonical_trigger_id))
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

struct DispatchOptions<'a> {
    job: &'a Job,
    ctx: &'a JobContext,
    run_id: &'a str,
    started_at: &'a str,
    params: &'a HashMap<String, String>,
    result_file: Option<&'a std::path::Path>,
    stream_log_path: Option<&'a std::path::Path>,
    policy: Option<JobPolicy>,
}

/// Run the per-type executor and normalize its return shape so the caller can
/// match on a single result type regardless of whether the job spawned a pane.
async fn dispatch_job(
    options: DispatchOptions<'_>,
) -> Result<(Option<i32>, String, String, Option<TmuxHandle>), String> {
    let DispatchOptions {
        job,
        ctx,
        run_id,
        started_at,
        params,
        result_file,
        stream_log_path,
        policy,
    } = options;
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
            execute_claude_job(
                job,
                &ctx.secrets,
                &ctx.settings,
                params,
                result_file,
                policy,
            )
            .await
        }
        JobType::Job => {
            execute_folder_job(
                job,
                &ctx.secrets,
                &ctx.settings,
                params,
                result_file,
                policy,
            )
            .await
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
    resource_lease: Option<crate::resource_policy::ResourceLease>,
) {
    match result {
        Ok((_, _, _, Some(handle))) => {
            // monitor owns finalization for tmux jobs; drop the unused output.
            attach_monitor(rc, handle, pane_tx, use_auto_yes, resource_lease);
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
            drop(resource_lease);
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
            drop(resource_lease);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::collect_result_file;
    use std::fs;

    #[test]
    fn structured_result_collection_reports_json_state() {
        let directory = tempfile::tempdir().expect("temporary result directory");
        let valid = directory.path().join("valid.json");
        fs::write(&valid, r#"{"draft":"hello"}"#).expect("write valid result");
        let collected = collect_result_file(Some(&valid));
        assert_eq!(collected.status, "valid");
        assert_eq!(collected.value.expect("parsed value")["draft"], "hello");

        let invalid = directory.path().join("invalid.json");
        fs::write(&invalid, "not-json").expect("write invalid result");
        let collected = collect_result_file(Some(&invalid));
        assert_eq!(collected.status, "invalid_json");
        assert!(collected.value.is_none());

        let missing = directory.path().join("missing.json");
        let collected = collect_result_file(Some(&missing));
        assert_eq!(collected.status, "missing");
        assert!(collected.error.is_none());
    }

    #[test]
    fn result_collection_without_trigger_is_explicitly_not_requested() {
        let collected = collect_result_file(None);
        assert_eq!(collected.status, "not_requested");
        assert!(collected.value.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn result_collection_does_not_follow_symlinks() {
        let directory = tempfile::tempdir().expect("temporary result directory");
        let target = directory.path().join("target.json");
        let link = directory.path().join("result.json");
        fs::write(&target, r#"{"draft":"private"}"#).expect("write target result");
        std::os::unix::fs::symlink(&target, &link).expect("create result symlink");

        let collected = collect_result_file(Some(&link));
        assert_eq!(collected.status, "unreadable");
        assert!(collected.value.is_none());
    }
}
