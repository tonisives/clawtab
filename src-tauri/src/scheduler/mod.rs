pub mod executor;
pub mod monitor;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::Utc;
use cron::Schedule;

use crate::config::jobs::{JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::secrets::SecretsManager;

pub struct SchedulerHandle {
    _handle: tauri::async_runtime::JoinHandle<()>,
}

pub fn start(
    jobs_config: Arc<Mutex<JobsConfig>>,
    secrets: Arc<Mutex<SecretsManager>>,
    history: Arc<Mutex<HistoryStore>>,
    settings: Arc<Mutex<AppSettings>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
) -> SchedulerHandle {
    let handle = tauri::async_runtime::spawn(async move {
        run_loop(jobs_config, secrets, history, settings, job_status).await;
    });
    SchedulerHandle { _handle: handle }
}

async fn run_loop(
    jobs_config: Arc<Mutex<JobsConfig>>,
    secrets: Arc<Mutex<SecretsManager>>,
    history: Arc<Mutex<HistoryStore>>,
    settings: Arc<Mutex<AppSettings>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
) {
    let mut last_check = Utc::now();

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;

        let now = Utc::now();
        let jobs = {
            let config = jobs_config.lock().unwrap();
            config.jobs.clone()
        };

        for job in &jobs {
            if !job.enabled {
                continue;
            }

            let schedule: Schedule = match job.cron.parse() {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("Invalid cron expression for job '{}': {}", job.name, e);
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
                tauri::async_runtime::spawn(async move {
                    executor::execute_job(
                        &job, &secrets, &history, &settings, &job_status, "cron",
                    )
                    .await;
                });
            }
        }

        last_check = now;
    }
}
