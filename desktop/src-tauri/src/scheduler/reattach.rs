use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::config::jobs::{JobStatus, JobType, JobsConfig, NotifyTarget};
use crate::config::settings::AppSettings;
use crate::events::EventSink;
use crate::history::HistoryStore;
use crate::relay::RelayHandle;
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
    settings: &Arc<Mutex<AppSettings>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    history: &Arc<Mutex<HistoryStore>>,
    active_agents: &Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
    auto_yes_panes: &Arc<Mutex<HashSet<String>>>,
) {
    if !tmux::is_available() {
        return;
    }

    let (jobs, default_session, telegram_config) = {
        let jc = jobs_config.lock().unwrap();
        let s = settings.lock().unwrap();
        (
            jc.jobs.clone(),
            s.default_tmux_session.clone(),
            s.telegram.clone(),
        )
    };

    // Build slug -> job map (only tmux-based jobs)
    let slug_to_job: HashMap<&str, _> = jobs
        .iter()
        .filter(|j| matches!(j.job_type, JobType::Claude | JobType::Job))
        .map(|j| (j.slug.as_str(), j))
        .collect();

    if slug_to_job.is_empty() {
        return;
    }

    // Get all unfinished runs that have a pane_id stored
    let unfinished = {
        let h = history.lock().unwrap();
        match h.get_unfinished_with_pane() {
            Ok(runs) => runs,
            Err(e) => {
                log::warn!("Failed to query unfinished runs: {}", e);
                return;
            }
        }
    };

    let mut reattached = 0;

    for run in &unfinished {
        let job = match slug_to_job.get(run.job_id.as_str()) {
            Some(j) if j.enabled => *j,
            _ => continue,
        };

        let pane_id = match &run.pane_id {
            Some(id) => id.clone(),
            None => continue,
        };

        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| default_session.clone());

        // Check if pane is still alive and busy
        if !tmux::pane_exists(&pane_id) {
            // Pane is gone - finalize the orphaned run
            let h = history.lock().unwrap();
            let finished_at = Utc::now().to_rfc3339();
            if let Err(e) = h.update_finished(&run.id, &finished_at, None, "", "") {
                log::error!("Failed to finalize orphaned run {}: {}", run.id, e);
            }
            continue;
        }

        if !tmux::is_pane_busy(&session, &pane_id) {
            // Pane exists but process finished while we were down
            let h = history.lock().unwrap();
            let output = tmux::capture_pane_full(&pane_id)
                .unwrap_or_default()
                .trim()
                .to_string();
            let finished_at = Utc::now().to_rfc3339();
            if let Err(e) = h.update_finished(&run.id, &finished_at, None, &output, "") {
                log::error!("Failed to finalize orphaned run {}: {}", run.id, e);
            } else {
                log::info!(
                    "Finalized orphaned run '{}' for job '{}' ({} bytes captured)",
                    run.id,
                    job.name,
                    output.len(),
                );
                super::monitor::save_log_file(&job.slug, &run.id, &output);
            }
            continue;
        }

        // Pane is still running - reattach

        // Clean up any previous incomplete reattach records for this job
        {
            let h = history.lock().unwrap();
            if let Ok(old_runs) = h.get_by_job_id(&job.slug, 20) {
                let stale_ids: Vec<String> = old_runs
                    .into_iter()
                    .filter(|r| {
                        r.trigger == "reattach"
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
        }

        let run_id = format!("reattach-{}", uuid::Uuid::new_v4());
        let started_at = Utc::now().to_rfc3339();

        log::info!(
            "Reattaching job '{}' to pane {} in session '{}'",
            job.name,
            pane_id,
            session,
        );

        // Set status to Running
        {
            let mut status = job_status.lock().unwrap();
            status.insert(
                job.slug.clone(),
                JobStatus::Running {
                    run_id: run_id.clone(),
                    started_at: started_at.clone(),
                    pane_id: Some(pane_id.clone()),
                    tmux_session: Some(session.clone()),
                },
            );
        }

        // Restore auto-yes for this pane if the job has it enabled
        if job.auto_yes {
            let mut panes = auto_yes_panes.lock().unwrap();
            panes.insert(pane_id.clone());
            log::info!(
                "Auto-yes restored for reattached job '{}' pane '{}'",
                job.name,
                pane_id,
            );
        }

        // Create a history record for the reattached run
        {
            let h = history.lock().unwrap();
            let record = crate::history::RunRecord {
                id: run_id.clone(),
                job_id: job.slug.clone(),
                started_at: started_at.clone(),
                finished_at: None,
                exit_code: None,
                trigger: "reattach".to_string(),
                stdout: String::new(),
                stderr: String::new(),
                pane_id: Some(pane_id.clone()),
            };
            if let Err(e) = h.insert(&record) {
                log::error!("Failed to insert reattach record: {}", e);
            }
        }

        // Register in active_agents for Telegram
        {
            let chat_id = job.telegram_chat_id.or_else(|| {
                telegram_config
                    .as_ref()
                    .and_then(|c| c.chat_ids.first().copied())
            });
            if let Some(chat_id) = chat_id {
                if let Ok(mut map) = active_agents.lock() {
                    map.insert(
                        chat_id,
                        telegram::ActiveAgent {
                            pane_id: pane_id.clone(),
                            tmux_session: session.clone(),
                            run_id: run_id.clone(),
                            job_id: job.name.clone(),
                        },
                    );
                }
            }
        }

        // Build telegram stream for monitor (only when notify_target is Telegram)
        let telegram = if job.notify_target == NotifyTarget::Telegram {
            telegram_config.as_ref().and_then(|config| {
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
            })
        } else {
            None
        };

        let notify_on_success = telegram_config
            .as_ref()
            .map(|c| c.notify_on_success)
            .unwrap_or(true);

        let params = MonitorParams {
            tmux_session: session.clone(),
            pane_id: pane_id.clone(),
            run_id,
            job_id: job.name.clone(),
            slug: job.slug.clone(),
            kill_on_end: job.kill_on_end,
            telegram,
            telegram_notify: job.telegram_notify.clone(),
            notify_target: job.notify_target.clone(),
            history: Arc::clone(history),
            job_status: Arc::clone(job_status),
            notify_on_success,
            relay: Arc::clone(relay),
            notifier: None,
            is_reattach: true,
        };
        tokio::spawn(super::monitor::monitor_pane(params));

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

/// Kill leftover plain-shell windows from previous sessions.
///
/// Windows named `clawtab-shell-*` (created by `split_pane_plain`) and
/// `ct-clawtab-shell-*` (created by process demotion) are tracked only in
/// React state — after an app restart the app has no record of them, so any
/// that survive in tmux are orphans by definition.
pub fn cleanup_orphaned_shell_windows() {
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
