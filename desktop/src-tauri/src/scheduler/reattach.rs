use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::config::jobs::{JobStatus, JobType, JobsConfig, NotifyTarget};
use crate::events::EventSink;
use crate::job_context::JobContext;
use crate::telegram;
use crate::tmux;
use chrono::Utc;

use super::monitor::{MonitorParams, TelegramStream};

/// Scan the history DB for unfinished runs that have a pane_id, then check if
/// those panes are still alive in tmux. For each match, set the job status to
/// Running and spawn a monitor.
pub fn reattach_running_jobs(
    event_sink: &dyn EventSink,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
) {
    if !tmux::is_available() {
        return;
    }
    let (jobs, default_session, telegram_config) = load_reattach_inputs(jobs_config, &ctx.settings);
    let slug_to_job: HashMap<&str, &crate::config::jobs::Job> = jobs
        .iter()
        .filter(|j| matches!(j.job_type, JobType::Claude | JobType::Job))
        .map(|j| (j.slug.as_str(), j))
        .collect();
    let Some(mut unfinished) = load_unfinished_runs(&ctx.history) else {
        return;
    };
    // Older versions wrote a second unfinished row for each reattach. Prefer
    // the original run when both records still point at the same pane.
    unfinished.sort_by_key(|run| run.trigger == "reattach");

    let mut reattached = 0;
    let mut seen_panes = HashSet::new();
    for run in &unfinished {
        if run.trigger == "once" && !slug_to_job.contains_key(run.job_id.as_str()) {
            let Some(pane_id) = run.pane_id.as_deref() else { continue };
            if !seen_panes.insert(pane_id.to_string()) { continue; }
            if reattach_retired_one_shot(run, pane_id, &default_session, ctx) {
                reattached += 1;
            }
            continue;
        }
        let Some(job) = slug_to_job
            .get(run.job_id.as_str())
            .copied()
            .filter(|j| j.enabled || j.run_once.is_some())
        else {
            continue;
        };
        let Some(pane_id) = run.pane_id.clone() else {
            continue;
        };
        if !seen_panes.insert(pane_id.clone()) {
            continue;
        }
        if run.trigger != "reattach" {
            cleanup_stale_reattach_records(&job.slug, &pane_id, &ctx.history);
        }
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| default_session.clone());

        if finalize_if_dead_or_idle(run, job, &pane_id, &ctx.history) {
            continue;
        }
        reattach_one_run(run, job, &session, &pane_id, ctx, telegram_config.as_ref());
        reattached += 1;
    }

    if reattached > 0 {
        log::info!(
            "Reattached {} running job(s) from previous session",
            reattached
        );
        event_sink.emit_jobs_changed();
    }
}

fn reattach_retired_one_shot(
    run: &crate::history::RunRecord,
    pane_id: &str,
    default_session: &str,
    ctx: &JobContext,
) -> bool {
    match tmux::pane_process_state(pane_id) {
        Ok(tmux::PaneProcessState::Running) => {
            let (group, name) = run.job_id.split_once('/').unwrap_or(("default", &run.job_id));
            mark_running(&run.job_id, &run.id, &run.started_at, pane_id, default_session, &ctx.job_status);
            let params = MonitorParams {
                tmux_session: default_session.to_string(),
                pane_id: pane_id.to_string(),
                run_id: run.id.clone(),
                job_id: name.to_string(),
                group_name: group.to_string(),
                slug: run.job_id.clone(),
                agent_group: None,
                agent_prompt_path: None,
                retired_one_shot: true,
                kill_on_end: false,
                telegram: None,
                telegram_notify: Default::default(),
                notify_target: NotifyTarget::None,
                history: Arc::clone(&ctx.history),
                job_status: Arc::clone(&ctx.job_status),
                notify_on_success: false,
                relay: Arc::clone(&ctx.relay),
                notifier: None,
                is_reattach: true,
                protected_panes: Arc::clone(&ctx.protected_panes),
                trigger_id: None,
                result_file: None,
                resource_lease: None,
            };
            tokio::spawn(super::monitor::monitor_pane(params));
            true
        }
        Ok(state) => {
            let exit_code = match state {
                tmux::PaneProcessState::Exited(code) => code,
                _ => None,
            };
            let output = tmux::capture_pane_full(pane_id).unwrap_or_default();
            let history = ctx.history.lock();
            let _ = history.update_finished(&run.id, &Utc::now().to_rfc3339(), exit_code, &output, "");
            if let Some(path) = super::monitor::save_log_file(&run.job_id, &run.id, &output, None, true) {
                let _ = history.update_log_path(&run.id, &path.to_string_lossy());
            }
            false
        }
        Err(error) => {
            log::warn!("Could not inspect retired one-time pane {}: {}", pane_id, error);
            false
        }
    }
}

fn load_reattach_inputs(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    settings: &Arc<Mutex<crate::config::settings::AppSettings>>,
) -> (
    Vec<crate::config::jobs::Job>,
    String,
    Option<crate::telegram::TelegramConfig>,
) {
    let jc = jobs_config.lock();
    let s = settings.lock();
    (
        jc.jobs.clone(),
        s.default_tmux_session.clone(),
        s.telegram.clone(),
    )
}

fn load_unfinished_runs(
    history: &Arc<Mutex<crate::history::HistoryStore>>,
) -> Option<Vec<crate::history::RunRecord>> {
    let h = history.lock();
    match h.get_unfinished_with_pane() {
        Ok(runs) => Some(runs),
        Err(e) => {
            log::warn!("Failed to query unfinished runs: {}", e);
            None
        }
    }
}

/// Returns true if the run was finalized (dead pane or idle pane) and the
/// caller should skip reattaching it.
fn finalize_if_dead_or_idle(
    run: &crate::history::RunRecord,
    job: &crate::config::jobs::Job,
    pane_id: &str,
    history: &Arc<Mutex<crate::history::HistoryStore>>,
) -> bool {
    match tmux::pane_process_state(pane_id) {
        Ok(tmux::PaneProcessState::Running) => false,
        Ok(tmux::PaneProcessState::Exited(exit_code)) => {
            finalize_idle_pane(run, job, pane_id, exit_code, history);
            true
        }
        Ok(tmux::PaneProcessState::Missing) => {
            finalize_idle_pane(run, job, pane_id, None, history);
            true
        }
        Err(error) => {
            log::warn!(
                "Could not inspect pane {} for job '{}': {}",
                pane_id,
                job.name,
                error
            );
            true
        }
    }
}

fn finalize_idle_pane(
    run: &crate::history::RunRecord,
    job: &crate::config::jobs::Job,
    pane_id: &str,
    exit_code: Option<i32>,
    history: &Arc<Mutex<crate::history::HistoryStore>>,
) {
    let h = history.lock();
    let output = tmux::capture_pane_full(pane_id)
        .unwrap_or_default()
        .trim()
        .to_string();
    let finished_at = Utc::now().to_rfc3339();
    if let Err(e) = h.update_finished(&run.id, &finished_at, exit_code, &output, "") {
        log::error!("Failed to finalize orphaned run {}: {}", run.id, e);
    } else {
        log::info!(
            "Finalized orphaned run '{}' for job '{}' ({} bytes captured)",
            run.id,
            job.name,
            output.len(),
        );
        if let Some(path) = super::monitor::save_log_file(
            &job.slug,
            &run.id,
            &output,
            (job.group == "agent")
                .then(|| crate::agent::agent_group_from_slug(&job.slug))
                .as_deref(),
            job.run_once.as_ref().is_some_and(|once| once.remove_after_start),
        ) {
            let _ = h.update_log_path(&run.id, &path.to_string_lossy());
        }
    }
}

fn reattach_one_run(
    run: &crate::history::RunRecord,
    job: &crate::config::jobs::Job,
    session: &str,
    pane_id: &str,
    ctx: &JobContext,
    telegram_config: Option<&crate::telegram::TelegramConfig>,
) {
    log::info!(
        "Reattaching job '{}' to pane {} in session '{}'",
        job.name,
        pane_id,
        session,
    );

    mark_running(
        &job.slug,
        &run.id,
        &run.started_at,
        pane_id,
        session,
        &ctx.job_status,
    );
    restore_auto_yes(job, pane_id, &ctx.auto_yes_panes);
    register_active_agent(job, &run.id, pane_id, session, ctx, telegram_config);
    spawn_reattach_monitor(job, run.id.clone(), pane_id, session, ctx, telegram_config);
}

fn cleanup_stale_reattach_records(
    slug: &str,
    pane_id: &str,
    history: &Arc<Mutex<crate::history::HistoryStore>>,
) {
    let h = history.lock();
    let Ok(old_runs) = h.get_by_job_id(slug, 20) else {
        return;
    };
    let stale_ids: Vec<String> = old_runs
        .into_iter()
        .filter(|r| {
            r.trigger == "reattach"
                && r.pane_id.as_deref() == Some(pane_id)
                && r.finished_at.is_none()
                && r.stdout.is_empty()
                && r.stderr.is_empty()
        })
        .map(|r| r.id)
        .collect();
    if !stale_ids.is_empty() {
        let _ = h.delete_by_ids(&stale_ids);
    }
}

fn mark_running(
    slug: &str,
    run_id: &str,
    started_at: &str,
    pane_id: &str,
    session: &str,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) {
    let mut status = job_status.lock();
    status.insert(
        slug.to_string(),
        JobStatus::Running {
            run_id: run_id.to_string(),
            started_at: started_at.to_string(),
            pane_id: Some(pane_id.to_string()),
            tmux_session: Some(session.to_string()),
        },
    );
}

fn restore_auto_yes(
    job: &crate::config::jobs::Job,
    pane_id: &str,
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
) {
    if !job.auto_yes {
        return;
    }
    let mut panes = auto_yes_panes.lock();
    panes.insert(pane_id.to_string());
    let pane_set = panes.clone();
    drop(panes);
    if let Err(error) = crate::tmux::sync_auto_yes_bell_monitoring(&pane_set) {
        log::warn!(
            "failed to sync auto-yes terminal bell suppression: {}",
            error
        );
    }
    log::info!(
        "Auto-yes restored for reattached job '{}' pane '{}'",
        job.name,
        pane_id,
    );
}

fn register_active_agent(
    job: &crate::config::jobs::Job,
    run_id: &str,
    pane_id: &str,
    session: &str,
    ctx: &JobContext,
    telegram_config: Option<&crate::telegram::TelegramConfig>,
) {
    let chat_id = job
        .telegram_chat_id
        .or_else(|| telegram_config.and_then(|c| c.chat_ids.first().copied()));
    let Some(chat_id) = chat_id else { return };
    let mut map = ctx.active_agents.lock();
    map.insert(
        chat_id,
        telegram::ActiveAgent {
            pane_id: pane_id.to_string(),
            tmux_session: session.to_string(),
            run_id: run_id.to_string(),
            job_id: job.name.clone(),
        },
    );
    drop(map);
    ctx.active_agents_notify.notify_waiters();
}

fn spawn_reattach_monitor(
    job: &crate::config::jobs::Job,
    run_id: String,
    pane_id: &str,
    session: &str,
    ctx: &JobContext,
    telegram_config: Option<&crate::telegram::TelegramConfig>,
) {
    let telegram = build_telegram_stream(job, telegram_config);
    let notify_on_success = telegram_config.map(|c| c.notify_on_success).unwrap_or(true);
    let params = MonitorParams {
        tmux_session: session.to_string(),
        pane_id: pane_id.to_string(),
        run_id,
        job_id: job.name.clone(),
        group_name: crate::config::jobs::job_group(job).to_string(),
        slug: job.slug.clone(),
        agent_group: (job.group == "agent").then(|| crate::agent::agent_group_from_slug(&job.slug)),
        agent_prompt_path: (job.group == "agent").then(|| std::path::PathBuf::from(&job.path)),
        retired_one_shot: job.run_once.as_ref().is_some_and(|once| once.remove_after_start),
        kill_on_end: job.kill_on_end,
        telegram,
        telegram_notify: job.telegram_notify.clone(),
        notify_target: job.notify_target.clone(),
        history: Arc::clone(&ctx.history),
        job_status: Arc::clone(&ctx.job_status),
        notify_on_success,
        relay: Arc::clone(&ctx.relay),
        notifier: None,
        is_reattach: true,
        protected_panes: Arc::clone(&ctx.protected_panes),
        trigger_id: None,
        result_file: None,
        resource_lease: None,
    };
    tokio::spawn(super::monitor::monitor_pane(params));
}

fn build_telegram_stream(
    job: &crate::config::jobs::Job,
    telegram_config: Option<&crate::telegram::TelegramConfig>,
) -> Option<TelegramStream> {
    if job.notify_target != NotifyTarget::Telegram {
        return None;
    }
    let config = telegram_config?;
    if !config.is_configured() {
        return None;
    }
    let chat_id = job
        .telegram_chat_id
        .or_else(|| config.chat_ids.first().copied())?;
    Some(TelegramStream {
        bot_token: config.bot_token.clone(),
        chat_id,
    })
}

/// Kill leftover plain-shell windows from previous sessions.
///
/// Windows named `clawtab-shell-*` (created by `split_pane_plain`) and
/// `ct-clawtab-shell-*` (created by process demotion) are tracked only in
/// React state — after an app restart the app has no record of them, so any
/// that survive in tmux are orphans by definition.
///
/// `protected_panes` names pane IDs currently open in ClawTab's UI -- any
/// window containing such a pane is skipped so the user's live view is safe.
pub fn cleanup_orphaned_shell_windows(protected_panes: &HashSet<String>) {
    if !tmux::is_available() {
        return;
    }

    let sessions = match tmux::list_sessions() {
        Ok(s) => s,
        Err(e) => {
            log::debug!(
                "cleanup_orphaned_shell_windows: list_sessions failed: {}",
                e
            );
            return;
        }
    };

    let mut killed = 0usize;
    for session in &sessions {
        let windows = match tmux::list_windows(session) {
            Ok(w) => w,
            Err(e) => {
                log::debug!(
                    "cleanup_orphaned_shell_windows: list_windows({}) failed: {}",
                    session,
                    e
                );
                continue;
            }
        };
        for w in windows {
            if w.name.starts_with("clawtab-shell-") || w.name.starts_with("ct-clawtab-shell-") {
                // Skip if any pane in this window is currently open in ClawTab.
                if !protected_panes.is_empty() {
                    if let Ok(panes) = tmux::list_panes_in_window(session, &w.name) {
                        if panes.iter().any(|p| protected_panes.contains(p)) {
                            log::info!(
                                "cleanup_orphaned_shell_windows: keeping {}:{} -- pane open in ClawTab",
                                session,
                                w.name
                            );
                            continue;
                        }
                    }
                }
                match tmux::kill_window(session, &w.name) {
                    Ok(_) => {
                        killed += 1;
                        log::info!(
                            "cleanup_orphaned_shell_windows: killed {}:{}",
                            session,
                            w.name
                        );
                    }
                    Err(e) => log::debug!(
                        "cleanup_orphaned_shell_windows: kill {}:{} failed: {}",
                        session,
                        w.name,
                        e
                    ),
                }
            }
        }
    }

    if killed > 0 {
        log::info!(
            "cleanup_orphaned_shell_windows: killed {} orphan(s)",
            killed
        );
    }
}
