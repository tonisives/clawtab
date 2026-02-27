use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;

use crate::config::jobs::{Job, JobStatus, JobType, JobsConfig, NotifyTarget};
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::relay::RelayHandle;
use crate::telegram;
use crate::tmux;

use super::monitor::{MonitorParams, TelegramStream};

/// Scan tmux for panes that are still running jobs from a previous app session.
/// For each match, set the job status to Running and spawn a monitor.
pub fn reattach_running_jobs(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    settings: &Arc<Mutex<AppSettings>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    history: &Arc<Mutex<HistoryStore>>,
    active_agents: &Arc<Mutex<HashMap<i64, telegram::ActiveAgent>>>,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
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

    // Only claude/folder jobs use tmux
    let tmux_jobs: Vec<&Job> = jobs
        .iter()
        .filter(|j| matches!(j.job_type, JobType::Claude | JobType::Folder))
        .collect();

    if tmux_jobs.is_empty() {
        return;
    }

    // Collect all unique tmux sessions these jobs might use
    let mut sessions: Vec<String> = tmux_jobs
        .iter()
        .map(|j| {
            j.tmux_session
                .clone()
                .unwrap_or_else(|| default_session.clone())
        })
        .collect();
    sessions.sort();
    sessions.dedup();

    // Build a map: window_name -> Vec<&Job> for matching
    let mut window_to_jobs: HashMap<String, Vec<&Job>> = HashMap::new();
    for job in &tmux_jobs {
        let window_name = project_window_name(job);
        window_to_jobs
            .entry(window_name)
            .or_default()
            .push(job);
    }

    let mut reattached = 0;

    for session in &sessions {
        if !tmux::session_exists(session) {
            continue;
        }

        let panes = match tmux::list_session_panes(session) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("Failed to list panes in session '{}': {}", session, e);
                continue;
            }
        };

        for (window_name, pane_info) in &panes {
            // Only consider panes in cwt- windows
            if !window_name.starts_with("cwt-") {
                continue;
            }

            // Check if this pane is busy (has a running process, not just a shell)
            if !tmux::is_pane_busy(session, &pane_info.pane_id) {
                continue;
            }

            // Find matching jobs for this window
            let matching_jobs = match window_to_jobs.get(window_name) {
                Some(jobs) => jobs,
                None => continue,
            };

            // Pick the first enabled job that matches this window.
            // If multiple jobs share a window, we can't perfectly distinguish,
            // but reattaching to one is better than losing all of them.
            let job = match matching_jobs.iter().find(|j| j.enabled) {
                Some(j) => *j,
                None => continue,
            };

            // Check if this job already has a status (avoid double-attach)
            {
                let status = job_status.lock().unwrap();
                if let Some(JobStatus::Running { .. }) = status.get(&job.name) {
                    continue;
                }
            }

            let run_id = format!("reattach-{}", uuid::Uuid::new_v4());
            let started_at = Utc::now().to_rfc3339();

            log::info!(
                "Reattaching job '{}' to pane {} in session '{}' (window '{}')",
                job.name,
                pane_info.pane_id,
                session,
                window_name,
            );

            // Set status to Running
            {
                let mut status = job_status.lock().unwrap();
                status.insert(
                    job.name.clone(),
                    JobStatus::Running {
                        run_id: run_id.clone(),
                        started_at: started_at.clone(),
                        pane_id: Some(pane_info.pane_id.clone()),
                        tmux_session: Some(session.clone()),
                    },
                );
            }

            // Create a history record for the reattached run
            {
                let h = history.lock().unwrap();
                let record = crate::history::RunRecord {
                    id: run_id.clone(),
                    job_name: job.name.clone(),
                    started_at: started_at.clone(),
                    finished_at: None,
                    exit_code: None,
                    trigger: "reattach".to_string(),
                    stdout: String::new(),
                    stderr: String::new(),
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
                                pane_id: pane_info.pane_id.clone(),
                                tmux_session: session.clone(),
                                run_id: run_id.clone(),
                                job_name: job.name.clone(),
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
                pane_id: pane_info.pane_id.clone(),
                run_id,
                job_name: job.name.clone(),
                slug: job.slug.clone(),
                telegram,
                telegram_notify: job.telegram_notify.clone(),
                notify_target: job.notify_target.clone(),
                history: Arc::clone(history),
                job_status: Arc::clone(job_status),
                notify_on_success,
                relay: Arc::clone(relay),
            };
            tokio::spawn(super::monitor::monitor_pane(params));

            reattached += 1;
        }
    }

    if reattached > 0 {
        log::info!("Reattached {} running job(s) from previous session", reattached);
    }
}

fn project_window_name(job: &Job) -> String {
    let project = match job.slug.split_once('/') {
        Some((prefix, _)) if !prefix.is_empty() => prefix,
        _ => &job.name,
    };
    format!("cwt-{}", project)
}
