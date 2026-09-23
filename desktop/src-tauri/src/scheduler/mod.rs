pub mod executor;
pub mod monitor;
pub mod reattach;

use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::Arc;

use chrono::{Duration, Local, NaiveDateTime};
use cron::Schedule;

use crate::config::jobs::{JobStatus, JobType, JobsConfig};
use crate::job_context::JobContext;
use clawtab_protocol::CalendarSchedule;

pub async fn start(
    event_sink: Arc<dyn crate::events::EventSink>,
    jobs_config: Arc<Mutex<JobsConfig>>,
    ctx: JobContext,
) {
    log::info!("Scheduler started");
    emit_missed_cron_jobs(&jobs_config, &ctx, event_sink.as_ref());
    log_startup_schedules(&jobs_config);
    let launching_once = Arc::new(Mutex::new(HashSet::new()));
    run_due_one_shots(&jobs_config, &ctx, &launching_once, Local::now());

    let mut last_check = Local::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        let now = Local::now();
        run_due_jobs(&jobs_config, &ctx, &launching_once, last_check, now);
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
        if !job.enabled || !job_is_scheduled(job) || job.run_once.is_some() {
            continue;
        }
        let since = last_run_since(&ctx.history, &job.slug, lookback_limit);
        match job_due_between(job, since, now) {
            Ok(true) => {
                log::info!("Missed scheduled job detected: '{}'", job.name);
                missed_jobs.push(job.name.clone());
            }
            Ok(false) => {}
            Err(error) => {
                log::warn!("Invalid schedule for job '{}': {}", job.name, error);
            }
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

fn log_startup_schedules(jobs_config: &Arc<Mutex<JobsConfig>>) {
    let jobs = jobs_config.lock().jobs.clone();
    let scheduled_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.enabled && job_is_scheduled(job))
        .collect();
    log::info!(
        "Scheduler tracking {} scheduled job(s)",
        scheduled_jobs.len()
    );
    for job in &scheduled_jobs {
        if let Some(run_once) = &job.run_once {
            log::trace!("  '{}' one-time schedule at={}", job.name, run_once.at);
        } else if let Some(schedule) = &job.schedule {
            match next_calendar_occurrence(schedule, Local::now().naive_local()) {
                Ok(next) => {
                    log::trace!(
                        "  '{}' calendar_start='{}' every={} week(s) next={}",
                        job.name,
                        schedule.start,
                        schedule.repeat.every,
                        next
                    );
                }
                Err(error) => {
                    log::warn!(
                        "  '{}' calendar schedule FAILED TO PARSE: {}",
                        job.name,
                        error
                    );
                }
            }
        } else if let Some(schedules) = parse_cron(&job.cron) {
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
    launching_once: &Arc<Mutex<HashSet<String>>>,
    last_check: chrono::DateTime<Local>,
    now: chrono::DateTime<Local>,
) {
    let jobs = jobs_config.lock().jobs.clone();
    for job in &jobs {
        if !job.enabled || !job_is_scheduled(job) {
            continue;
        }
        if job.run_once.is_some() {
            if one_shot_due(job, ctx, now) {
                spawn_one_shot(job.clone(), jobs_config.clone(), ctx.clone(), launching_once.clone());
            }
            continue;
        }
        match job_due_between(job, last_check, now) {
            Ok(true) => {
                let trigger = if job.schedule.is_some() {
                    "calendar"
                } else {
                    "cron"
                };
                log::info!("{} trigger for job '{}'", trigger, job.name);
                spawn_scheduled_job(job.clone(), ctx.clone(), trigger);
            }
            Ok(false) => {}
            Err(error) => {
                log::warn!("Invalid schedule for job '{}': {}", job.name, error);
            }
        }
    }
}

fn run_due_one_shots(
    jobs_config: &Arc<Mutex<JobsConfig>>,
    ctx: &JobContext,
    launching_once: &Arc<Mutex<HashSet<String>>>,
    now: chrono::DateTime<Local>,
) {
    let jobs = jobs_config.lock().jobs.clone();
    for job in jobs.into_iter().filter(|job| job.enabled && one_shot_due(job, ctx, now)) {
        spawn_one_shot(job, jobs_config.clone(), ctx.clone(), launching_once.clone());
    }
}

fn one_shot_due(job: &crate::config::jobs::Job, ctx: &JobContext, now: chrono::DateTime<Local>) -> bool {
    let Some(schedule) = &job.run_once else { return false };
    if schedule.at > now || !job.enabled {
        return false;
    }
    !ctx.history.lock().get_by_job_id(&job.slug, 20).unwrap_or_default().iter()
        .any(|run| run.trigger == "once" && (run.pane_id.is_some() || (run.finished_at.is_some() && run.exit_code == Some(0))))
}

fn spawn_one_shot(
    job: crate::config::jobs::Job,
    jobs_config: Arc<Mutex<JobsConfig>>,
    ctx: JobContext,
    launching_once: Arc<Mutex<HashSet<String>>>,
) {
    if !launching_once.lock().insert(job.slug.clone()) {
        return;
    }
    tokio::spawn(async move {
        let started = executor::execute_job(
            &job, &ctx, "once", &std::collections::HashMap::new(),
            executor::ExecuteOpts { use_auto_yes: true, ..Default::default() },
        ).await;
        if started {
            let mut config = jobs_config.lock();
            let result = if job.run_once.as_ref().is_some_and(|once| once.remove_after_start) {
                config.delete_job(&job.slug)
            } else {
                let mut disabled = job.clone();
                disabled.enabled = false;
                config.save_job(&disabled)
            };
            if let Err(error) = result {
                log::error!("Failed to retire one-time job '{}': {}", job.slug, error);
            } else {
                *config = JobsConfig::load();
            }
        }
        launching_once.lock().remove(&job.slug);
    });
}

fn spawn_scheduled_job(job: crate::config::jobs::Job, ctx: JobContext, trigger: &'static str) {
    tokio::spawn(async move {
        executor::execute_job(
            &job,
            &ctx,
            trigger,
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

fn job_is_scheduled(job: &crate::config::jobs::Job) -> bool {
    job.run_once.is_some() || job.schedule.is_some() || !job.cron.is_empty()
}

fn job_due_between(
    job: &crate::config::jobs::Job,
    since: chrono::DateTime<Local>,
    now: chrono::DateTime<Local>,
) -> Result<bool, String> {
    if let Some(schedule) = &job.run_once {
        return Ok(schedule.at > since && schedule.at <= now);
    }
    if let Some(schedule) = &job.schedule {
        return calendar_due_between(schedule, since.naive_local(), now.naive_local());
    }

    let schedules =
        parse_cron(&job.cron).ok_or_else(|| format!("invalid cron expression '{}'", job.cron))?;
    Ok(has_missed_run(&schedules, since, now))
}

fn calendar_due_between(
    schedule: &CalendarSchedule,
    since: NaiveDateTime,
    now: NaiveDateTime,
) -> Result<bool, String> {
    if now <= since {
        return Ok(false);
    }
    Ok(next_calendar_occurrence(schedule, since)? <= now)
}

fn next_calendar_occurrence(
    schedule: &CalendarSchedule,
    after: NaiveDateTime,
) -> Result<NaiveDateTime, String> {
    if schedule.repeat.every == 0 {
        return Err("repeat.every must be at least 1".to_string());
    }

    let start = parse_calendar_start(&schedule.start)?;
    if after < start {
        return Ok(start);
    }

    let interval = match schedule.repeat.unit {
        clawtab_protocol::CalendarRepeatUnit::Week => {
            Duration::weeks(i64::from(schedule.repeat.every))
        }
    };
    let interval_seconds = interval.num_seconds();
    let elapsed_seconds = after.signed_duration_since(start).num_seconds();
    let occurrence_index = elapsed_seconds / interval_seconds + 1;
    let offset_seconds = interval_seconds
        .checked_mul(occurrence_index)
        .ok_or_else(|| "calendar schedule is outside the supported date range".to_string())?;

    start
        .checked_add_signed(Duration::seconds(offset_seconds))
        .ok_or_else(|| "calendar schedule is outside the supported date range".to_string())
}

fn parse_calendar_start(start: &str) -> Result<NaiveDateTime, String> {
    ["%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S"]
        .into_iter()
        .find_map(|format| NaiveDateTime::parse_from_str(start, format).ok())
        .ok_or_else(|| {
            format!(
                "start '{}' must use local date-time format YYYY-MM-DDTHH:MM",
                start
            )
        })
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

pub fn parse_cron(cron: &str) -> Option<Vec<Schedule>> {
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

#[cfg(test)]
mod tests {
    use super::{calendar_due_between, job_due_between, next_calendar_occurrence};
    use chrono::NaiveDateTime;
    use clawtab_protocol::{CalendarRepeat, CalendarRepeatUnit, CalendarSchedule};

    fn date(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M").expect("test date should be valid")
    }

    fn weekly_schedule(every: u32) -> CalendarSchedule {
        CalendarSchedule {
            start: "2026-08-03T09:00".to_string(),
            repeat: CalendarRepeat {
                every,
                unit: CalendarRepeatUnit::Week,
            },
        }
    }

    #[test]
    fn one_time_schedule_fires_only_across_its_timestamp() {
        let yaml = "name: review\njob_type: job\nenabled: true\npath: ''\ncron: ''\nrun_once:\n  at: '2026-10-02T09:00:00+07:00'\n  remove_after_start: true\n";
        let job = serde_yml::from_str(yaml).unwrap();
        let before = chrono::DateTime::parse_from_rfc3339("2026-10-02T08:59:00+07:00").unwrap().with_timezone(&chrono::Local);
        let at = chrono::DateTime::parse_from_rfc3339("2026-10-02T09:00:00+07:00").unwrap().with_timezone(&chrono::Local);
        let after = chrono::DateTime::parse_from_rfc3339("2026-10-02T09:01:00+07:00").unwrap().with_timezone(&chrono::Local);
        assert!(job_due_between(&job, before, at).unwrap());
        assert!(!job_due_between(&job, at, after).unwrap());
    }

    #[test]
    fn weekly_schedule_fires_at_its_anchor() {
        let schedule = weekly_schedule(1);

        assert!(calendar_due_between(
            &schedule,
            date("2026-08-03T08:59"),
            date("2026-08-03T09:00"),
        )
        .expect("schedule should be valid"));
    }

    #[test]
    fn every_other_week_uses_anchor_parity() {
        let schedule = weekly_schedule(2);

        assert!(!calendar_due_between(
            &schedule,
            date("2026-08-10T08:59"),
            date("2026-08-10T09:01"),
        )
        .expect("schedule should be valid"));
        assert!(calendar_due_between(
            &schedule,
            date("2026-08-17T08:59"),
            date("2026-08-17T09:01"),
        )
        .expect("schedule should be valid"));
    }

    #[test]
    fn next_occurrence_is_strictly_after_reference_time() {
        let schedule = weekly_schedule(2);

        let next = next_calendar_occurrence(&schedule, date("2026-08-03T09:00"))
            .expect("schedule should be valid");

        assert_eq!(next, date("2026-08-17T09:00"));
    }

    #[test]
    fn zero_repeat_interval_is_rejected() {
        let schedule = weekly_schedule(0);

        assert!(next_calendar_occurrence(&schedule, date("2026-08-03T08:00")).is_err());
    }
}
