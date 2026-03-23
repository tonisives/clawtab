pub mod executor;
pub mod monitor;
pub mod reattach;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{Duration, Local};
use cron::Schedule;

use tauri::Emitter;

use crate::config::jobs::{JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::relay::RelayHandle;
use crate::secrets::SecretsManager;
use crate::telegram::ActiveAgent;

pub struct SchedulerHandle {
    _handle: tauri::async_runtime::JoinHandle<()>,
}

pub fn start(
    app_handle: tauri::AppHandle,
    jobs_config: Arc<Mutex<JobsConfig>>,
    secrets: Arc<Mutex<SecretsManager>>,
    history: Arc<Mutex<HistoryStore>>,
    settings: Arc<Mutex<AppSettings>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    active_agents: Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    relay: Arc<Mutex<Option<RelayHandle>>>,
    auto_yes_panes: Arc<Mutex<HashSet<String>>>,
) -> SchedulerHandle {
    let handle = tauri::async_runtime::spawn(async move {
        run_loop(app_handle, jobs_config, secrets, history, settings, job_status, active_agents, relay, auto_yes_panes).await;
    });
    SchedulerHandle { _handle: handle }
}

async fn run_loop(
    app_handle: tauri::AppHandle,
    jobs_config: Arc<Mutex<JobsConfig>>,
    secrets: Arc<Mutex<SecretsManager>>,
    history: Arc<Mutex<HistoryStore>>,
    settings: Arc<Mutex<AppSettings>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    active_agents: Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    relay: Arc<Mutex<Option<RelayHandle>>>,
    auto_yes_panes: Arc<Mutex<HashSet<String>>>,
) {
    log::info!("Scheduler started");

    // Check for missed cron triggers since the last run of each job.
    // Emits an event to the frontend so the user can decide whether to run them.
    {
        let now = Local::now();
        let lookback_limit = now - Duration::hours(24);
        let jobs = {
            let config = jobs_config.lock().unwrap();
            config.jobs.clone()
        };

        let mut missed_jobs: Vec<String> = Vec::new();

        for job in &jobs {
            if !job.enabled || job.cron.is_empty() {
                continue;
            }

            let schedules = match parse_cron(&job.cron) {
                Some(s) => s,
                None => {
                    log::warn!("Invalid cron expression for job '{}': {}", job.name, job.cron);
                    continue;
                }
            };

            // Determine the earliest point to look back from: last run or 24h ago
            let since = {
                let h = history.lock().unwrap();
                h.get_by_job_name(&job.slug, 1)
                    .ok()
                    .and_then(|runs| runs.into_iter().next())
                    .and_then(|r| chrono::DateTime::parse_from_rfc3339(&r.started_at).ok())
                    .map(|t| t.with_timezone(&Local))
                    .filter(|t| *t > lookback_limit)
                    .unwrap_or(lookback_limit)
            };

            let missed = schedules.iter().any(|schedule| {
                schedule
                    .after(&since)
                    .take_while(|t| *t <= now)
                    .next()
                    .is_some()
            });

            if missed {
                log::info!("Missed cron job detected: '{}'", job.name);
                missed_jobs.push(job.name.clone());
            }
        }

        if !missed_jobs.is_empty() {
            log::info!("Emitting missed-cron-jobs event with {} jobs", missed_jobs.len());
            let _ = app_handle.emit("missed-cron-jobs", missed_jobs);
        }
    }

    let mut last_check = Local::now();

    // Log cron-enabled jobs and their next fire times at startup
    {
        let jobs = {
            let config = jobs_config.lock().unwrap();
            config.jobs.clone()
        };
        let cron_jobs: Vec<_> = jobs.iter().filter(|j| j.enabled && !j.cron.is_empty()).collect();
        log::info!("Scheduler tracking {} cron-enabled job(s)", cron_jobs.len());
        for job in &cron_jobs {
            if let Some(schedules) = parse_cron(&job.cron) {
                let next: Vec<String> = schedules
                    .iter()
                    .filter_map(|s| s.upcoming(Local).next())
                    .map(|t| t.to_rfc3339())
                    .collect();
                log::info!("  '{}' cron='{}' next={:?}", job.name, job.cron, next);
            } else {
                log::warn!("  '{}' cron='{}' FAILED TO PARSE", job.name, job.cron);
            }
        }
    }

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        let now = Local::now();
        let jobs = {
            let config = jobs_config.lock().unwrap();
            config.jobs.clone()
        };

        for job in &jobs {
            if !job.enabled || job.cron.is_empty() {
                continue;
            }

            let schedules = match parse_cron(&job.cron) {
                Some(s) => s,
                None => {
                    log::warn!("Invalid cron expression for job '{}': {}", job.name, job.cron);
                    continue;
                }
            };

            // Check if any scheduled time falls between last_check and now
            let should_run = schedules.iter().any(|schedule| {
                schedule
                    .after(&last_check)
                    .take_while(|t| *t <= now)
                    .next()
                    .is_some()
            });

            if should_run {
                log::info!("Cron trigger for job '{}'", job.name);
                let job = job.clone();
                let secrets = Arc::clone(&secrets);
                let history = Arc::clone(&history);
                let settings = Arc::clone(&settings);
                let job_status = Arc::clone(&job_status);
                let active_agents = Arc::clone(&active_agents);
                let relay = Arc::clone(&relay);
                let auto_yes_panes = Arc::clone(&auto_yes_panes);
                tauri::async_runtime::spawn(async move {
                    executor::execute_job_with_auto_yes(
                        &job, &secrets, &history, &settings, &job_status, "cron",
                        &active_agents, &relay, &std::collections::HashMap::new(),
                        Some(&auto_yes_panes), None,
                    )
                    .await;
                });
            }
        }

        last_check = now;
    }
}

fn parse_single_cron(cron: &str) -> Option<Schedule> {
    let parts: Vec<&str> = cron.split_whitespace().collect();
    let expr = if parts.len() == 5 {
        // 5-field cron: min hour dom month dow - prepend seconds
        let dow = translate_dow(parts[4]);
        format!("0 {} {} {} {} {}", parts[0], parts[1], parts[2], parts[3], dow)
    } else if parts.len() == 6 {
        // 6-field cron: sec min hour dom month dow
        let dow = translate_dow(parts[5]);
        format!("{} {} {} {} {} {}", parts[0], parts[1], parts[2], parts[3], parts[4], dow)
    } else {
        cron.to_string()
    };
    expr.parse().ok()
}

/// Translate day-of-week values from standard cron (0=Sun, 1-6=Mon-Sat)
/// to the `cron` crate format (1=Sun, 2-7=Mon-Sat). Handles comma-separated
/// lists and ranges.
fn translate_dow(dow: &str) -> String {
    if dow == "*" || dow == "?" {
        return dow.to_string();
    }
    dow.split(',')
        .map(|part| {
            if part.contains('-') {
                // Handle ranges like 0-5
                let bounds: Vec<&str> = part.split('-').collect();
                if bounds.len() == 2 {
                    let lo = bounds[0].parse::<u8>().map(|v| if v <= 6 { v + 1 } else { v }).map(|v| v.to_string()).unwrap_or_else(|_| bounds[0].to_string());
                    let hi = bounds[1].parse::<u8>().map(|v| if v <= 6 { v + 1 } else { v }).map(|v| v.to_string()).unwrap_or_else(|_| bounds[1].to_string());
                    format!("{}-{}", lo, hi)
                } else {
                    part.to_string()
                }
            } else {
                part.parse::<u8>().map(|v| if v <= 6 { v + 1 } else { v }).map(|v| v.to_string()).unwrap_or_else(|_| part.to_string())
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn parse_cron(cron: &str) -> Option<Vec<Schedule>> {
    let parts: Vec<&str> = cron.split('|').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let schedules: Vec<Schedule> = parts.iter().filter_map(|p| parse_single_cron(p)).collect();
    if schedules.is_empty() {
        None
    } else {
        Some(schedules)
    }
}
