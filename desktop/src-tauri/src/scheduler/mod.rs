pub mod executor;
pub mod monitor;
pub mod reattach;

use parking_lot::Mutex;
use std::sync::Arc;

use chrono::{Duration, Local};
use cron::Schedule;

use crate::config::jobs::{JobStatus, JobType, JobsConfig};
use crate::job_context::JobContext;

pub async fn start(
    event_sink: Arc<dyn crate::events::EventSink>,
    jobs_config: Arc<Mutex<JobsConfig>>,
    ctx: JobContext,
) {
    log::info!("Scheduler started");
    emit_missed_cron_jobs(&jobs_config, &ctx, event_sink.as_ref());
    log_startup_cron(&jobs_config);

    let mut last_check = Local::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let now = Local::now();
        run_due_jobs(&jobs_config, &ctx, last_check, now);
        cleanup_stale_running(&jobs_config, &ctx, event_sink.as_ref());
        last_check = now;
    }
}

fn emit_missed_cron_jobs(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
    event_sink: &dyn crate::events::EventSink,
) {
    let now = Local::now();
    let lookback_limit = now - Duration::hours(24);
    let jobs = jobs_config.lock().jobs.clone();
    let mut missed_jobs: Vec<String> = Vec::new();

    for job in &jobs {
        if !job.enabled || job.cron.is_empty() {
            continue;
        }
        let Some(schedules) = parse_cron(&job.cron) else {
            log::warn!(
                "Invalid cron expression for job '{}': {}",
                job.name,
                job.cron
            );
            continue;
        };
        let since = last_run_since(&ctx.history, &job.slug, lookback_limit);
        if has_missed_run(&schedules, since, now) {
            log::info!("Missed cron job detected: '{}'", job.name);
            missed_jobs.push(job.name.clone());
        }
    }

    if !missed_jobs.is_empty() {
        log::info!(
            "Emitting missed-cron-jobs event with {} jobs",
            missed_jobs.len()
        );
        event_sink.emit_missed_cron_jobs(missed_jobs);
    }
}

fn last_run_since(
    history: &Arc<Mutex<crate::history::HistoryStore>>,
    slug: &str,
    lookback_limit: chrono::DateTime<Local>,
) -> chrono::DateTime<Local> {
    let h = history.lock();
    h.get_by_job_id(slug, 1)
        .ok()
        .and_then(|runs| runs.into_iter().next())
        .and_then(|r| chrono::DateTime::parse_from_rfc3339(&r.started_at).ok())
        .map(|t| t.with_timezone(&Local))
        .filter(|t| *t > lookback_limit)
        .unwrap_or(lookback_limit)
}

fn has_missed_run(
    schedules: &[Schedule],
    since: chrono::DateTime<Local>,
    now: chrono::DateTime<Local>,
) -> bool {
    schedules
        .iter()
        .any(|s| s.after(&since).take_while(|t| *t <= now).next().is_some())
}

fn log_startup_cron(jobs_config: &Arc<Mutex<JobsConfig>>) {
    let jobs = jobs_config.lock().jobs.clone();
    let cron_jobs: Vec<_> = jobs
        .iter()
        .filter(|j| j.enabled && !j.cron.is_empty())
        .collect();
    log::info!("Scheduler tracking {} cron-enabled job(s)", cron_jobs.len());
    for job in &cron_jobs {
        if let Some(schedules) = parse_cron(&job.cron) {
            let next: Vec<String> = schedules
                .iter()
                .filter_map(|s| s.upcoming(Local).next())
                .map(|t| t.to_rfc3339())
                .collect();
            log::trace!("  '{}' cron='{}' next={:?}", job.name, job.cron, next);
        } else {
            log::warn!("  '{}' cron='{}' FAILED TO PARSE", job.name, job.cron);
        }
    }
}

fn run_due_jobs(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
    last_check: chrono::DateTime<Local>,
    now: chrono::DateTime<Local>,
) {
    let jobs = jobs_config.lock().jobs.clone();
    for job in &jobs {
        if !job.enabled || job.cron.is_empty() {
            continue;
        }
        let Some(schedules) = parse_cron(&job.cron) else {
            log::warn!(
                "Invalid cron expression for job '{}': {}",
                job.name,
                job.cron
            );
            continue;
        };
        if has_missed_run(&schedules, last_check, now) {
            log::info!("Cron trigger for job '{}'", job.name);
            spawn_cron_job(job.clone(), ctx.clone());
        }
    }
}

fn spawn_cron_job(job: crate::config::jobs::Job, ctx: JobContext) {
    tokio::spawn(async move {
        executor::execute_job(
            &job,
            &ctx,
            "cron",
            &std::collections::HashMap::new(),
            executor::ExecuteOpts {
                use_auto_yes: true,
                pane_tx: None,
                ..Default::default()
            },
        )
        .await;
    });
}

fn cleanup_stale_running(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
    event_sink: &dyn crate::events::EventSink,
) {
    let binary_slugs: std::collections::HashSet<String> = jobs_config
        .lock()
        .jobs
        .iter()
        .filter(|job| matches!(job.job_type, JobType::Binary))
        .map(|job| job.slug.clone())
        .collect();
    let stale: Vec<(String, String)> = {
        let statuses = ctx.job_status.lock();
        statuses
            .iter()
            .filter_map(|(slug, status)| {
                if let JobStatus::Running {
                    pane_id: Some(pid), ..
                } = status
                {
                    if !crate::tmux::pane_exists(pid) {
                        return Some((slug.clone(), pid.clone()));
                    }
                } else if matches!(status, JobStatus::Running { .. })
                    && binary_slugs.contains(slug)
                    && !executor::binary_runtime::is_running(slug)
                {
                    return Some((slug.clone(), "binary process".to_string()));
                }
                None
            })
            .collect()
    };
    if stale.is_empty() {
        return;
    }
    let mut statuses = ctx.job_status.lock();
    for (slug, pane_id) in &stale {
        log::warn!(
            "Stale running job '{}' (pane {} gone) - resetting to Idle",
            slug,
            pane_id,
        );
        let next = JobStatus::Idle;
        statuses.insert(slug.clone(), next.clone());
        crate::relay::push_status_update(&ctx.relay, slug, &next);
    }
    drop(statuses);
    event_sink.emit_jobs_changed();
}

fn parse_single_cron(cron: &str) -> Option<Schedule> {
    let parts: Vec<&str> = cron.split_whitespace().collect();
    let expr = if parts.len() == 5 {
        // 5-field cron: min hour dom month dow - prepend seconds
        let dow = translate_dow(parts[4]);
        format!(
            "0 {} {} {} {} {}",
            parts[0], parts[1], parts[2], parts[3], dow
        )
    } else if parts.len() == 6 {
        // 6-field cron: sec min hour dom month dow
        let dow = translate_dow(parts[5]);
        format!(
            "{} {} {} {} {} {}",
            parts[0], parts[1], parts[2], parts[3], parts[4], dow
        )
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
                    let lo = bounds[0]
                        .parse::<u8>()
                        .map(|v| if v <= 6 { v + 1 } else { v })
                        .map(|v| v.to_string())
                        .unwrap_or_else(|_| bounds[0].to_string());
                    let hi = bounds[1]
                        .parse::<u8>()
                        .map(|v| if v <= 6 { v + 1 } else { v })
                        .map(|v| v.to_string())
                        .unwrap_or_else(|_| bounds[1].to_string());
                    format!("{}-{}", lo, hi)
                } else {
                    part.to_string()
                }
            } else {
                part.parse::<u8>()
                    .map(|v| if v <= 6 { v + 1 } else { v })
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| part.to_string())
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn parse_cron(cron: &str) -> Option<Vec<Schedule>> {
    let parts: Vec<&str> = cron
        .split('|')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
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
