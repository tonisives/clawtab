pub mod executor;
pub mod monitor;
pub mod reattach;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{Duration, Utc};
use cron::Schedule;

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
    jobs_config: Arc<Mutex<JobsConfig>>,
    secrets: Arc<Mutex<SecretsManager>>,
    history: Arc<Mutex<HistoryStore>>,
    settings: Arc<Mutex<AppSettings>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    active_agents: Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    relay: Arc<Mutex<Option<RelayHandle>>>,
) -> SchedulerHandle {
    let handle = tauri::async_runtime::spawn(async move {
        run_loop(jobs_config, secrets, history, settings, job_status, active_agents, relay).await;
    });
    SchedulerHandle { _handle: handle }
}

async fn run_loop(
    jobs_config: Arc<Mutex<JobsConfig>>,
    secrets: Arc<Mutex<SecretsManager>>,
    history: Arc<Mutex<HistoryStore>>,
    settings: Arc<Mutex<AppSettings>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    active_agents: Arc<Mutex<HashMap<i64, ActiveAgent>>>,
    relay: Arc<Mutex<Option<RelayHandle>>>,
) {
    // Catch up on missed cron triggers since the last run of each job.
    // This handles the case where the app was not running when a job was scheduled.
    {
        let now = Utc::now();
        let lookback_limit = now - Duration::hours(24);
        let jobs = {
            let config = jobs_config.lock().unwrap();
            config.jobs.clone()
        };

        for job in &jobs {
            if !job.enabled || job.cron.is_empty() {
                continue;
            }

            let schedule = match parse_cron(&job.cron) {
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
                    .map(|t| t.with_timezone(&Utc))
                    .filter(|t| *t > lookback_limit)
                    .unwrap_or(lookback_limit)
            };

            let missed = schedule
                .after(&since)
                .take_while(|t| *t <= now)
                .next()
                .is_some();

            if missed {
                log::info!("Catchup trigger for missed job '{}'", job.name);
                let job = job.clone();
                let secrets = Arc::clone(&secrets);
                let history = Arc::clone(&history);
                let settings = Arc::clone(&settings);
                let job_status = Arc::clone(&job_status);
                let active_agents = Arc::clone(&active_agents);
                let relay = Arc::clone(&relay);
                tauri::async_runtime::spawn(async move {
                    executor::execute_job(
                        &job, &secrets, &history, &settings, &job_status, "cron",
                        &active_agents, &relay, &std::collections::HashMap::new(),
                    )
                    .await;
                });
            }
        }
    }

    let mut last_check = Utc::now();

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        let now = Utc::now();
        let jobs = {
            let config = jobs_config.lock().unwrap();
            config.jobs.clone()
        };

        for job in &jobs {
            if !job.enabled || job.cron.is_empty() {
                continue;
            }

            let schedule = match parse_cron(&job.cron) {
                Some(s) => s,
                None => {
                    log::warn!("Invalid cron expression for job '{}': {}", job.name, job.cron);
                    continue;
                }
            };

            // Check if any scheduled time falls between last_check and now
            let should_run = schedule
                .after(&last_check)
                .take_while(|t| *t <= now)
                .next()
                .is_some();

            if should_run {
                log::info!("Cron trigger for job '{}'", job.name);
                let job = job.clone();
                let secrets = Arc::clone(&secrets);
                let history = Arc::clone(&history);
                let settings = Arc::clone(&settings);
                let job_status = Arc::clone(&job_status);
                let active_agents = Arc::clone(&active_agents);
                let relay = Arc::clone(&relay);
                tauri::async_runtime::spawn(async move {
                    executor::execute_job(
                        &job, &secrets, &history, &settings, &job_status, "cron",
                        &active_agents, &relay, &std::collections::HashMap::new(),
                    )
                    .await;
                });
            }
        }

        last_check = now;
    }
}

fn parse_cron(cron: &str) -> Option<Schedule> {
    let expr = if cron.split_whitespace().count() == 5 {
        format!("0 {}", cron)
    } else {
        cron.to_string()
    };
    expr.parse().ok()
}
