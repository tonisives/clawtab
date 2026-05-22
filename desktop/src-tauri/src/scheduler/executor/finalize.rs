use std::sync::Arc;

use chrono::Utc;

use crate::config::jobs::{Job, JobStatus, NotifyTarget};
use crate::job_context::JobContext;
use crate::telegram::{ActiveAgent, TelegramConfig};

use super::super::monitor::MonitorParams;
use super::notification::{build_telegram_stream, send_job_notification};
use super::TmuxHandle;

/// Wire up a freshly-spawned tmux pane: update Running status with pane info,
/// persist pane_id, register auto_yes + active_agents, then spawn the monitor.
/// Caller should return immediately after this; the monitor owns finalization.
#[allow(clippy::too_many_arguments)]
pub(super) fn attach_monitor(
    job: &Job,
    ctx: &JobContext,
    handle: TmuxHandle,
    run_id: &str,
    started_at: &str,
    trigger_id: &Option<String>,
    result_file: &Option<std::path::PathBuf>,
    telegram_config: &Option<TelegramConfig>,
    pane_tx: &mut Option<tokio::sync::oneshot::Sender<(String, String)>>,
    use_auto_yes: bool,
) {
    {
        let new_status = JobStatus::Running {
            run_id: run_id.to_string(),
            started_at: started_at.to_string(),
            pane_id: Some(handle.pane_id.clone()),
            tmux_session: Some(handle.tmux_session.clone()),
        };
        let mut status = ctx.job_status.lock();
        status.insert(job.slug.clone(), new_status.clone());
        drop(status);
        crate::relay::push_status_update(&ctx.relay, &job.slug, &new_status);
    }

    if let Some(tx) = pane_tx.take() {
        let _ = tx.send((handle.pane_id.clone(), handle.tmux_session.clone()));
    }

    {
        let h = ctx.history.lock();
        let _ = h.update_pane_id(run_id, &handle.pane_id);
    }

    if job.auto_yes && use_auto_yes {
        let mut panes = ctx.auto_yes_panes.lock();
        panes.insert(handle.pane_id.clone());
        log::info!(
            "Auto-yes enabled for job '{}' pane '{}'",
            job.name,
            handle.pane_id
        );
    }

    if job.notify_target == NotifyTarget::Telegram {
        let chat_id = job.telegram_chat_id.or_else(|| {
            telegram_config
                .as_ref()
                .and_then(|c| c.chat_ids.first().copied())
        });
        if let Some(chat_id) = chat_id {
            let mut map = ctx.active_agents.lock();
            log::info!(
                "Registering active agent for chat_id={} pane={}",
                chat_id,
                handle.pane_id,
            );
            map.insert(
                chat_id,
                ActiveAgent {
                    pane_id: handle.pane_id.clone(),
                    tmux_session: handle.tmux_session.clone(),
                    run_id: run_id.to_string(),
                    job_id: job.name.clone(),
                },
            );
            ctx.active_agents_notify.notify_waiters();
        }
    }

    let telegram = if job.notify_target == NotifyTarget::Telegram {
        build_telegram_stream(telegram_config, job.telegram_chat_id)
    } else {
        None
    };
    let notify_on_success = telegram_config
        .as_ref()
        .map(|c| c.notify_on_success)
        .unwrap_or(true);

    let params = MonitorParams {
        tmux_session: handle.tmux_session,
        pane_id: handle.pane_id,
        run_id: run_id.to_string(),
        job_id: job.name.clone(),
        slug: job.slug.clone(),
        kill_on_end: job.kill_on_end,
        telegram,
        telegram_notify: job.telegram_notify.clone(),
        notify_target: job.notify_target.clone(),
        history: Arc::clone(&ctx.history),
        job_status: Arc::clone(&ctx.job_status),
        notify_on_success,
        relay: Arc::clone(&ctx.relay),
        notifier: ctx.notifier.clone(),
        is_reattach: false,
        protected_panes: Arc::clone(&ctx.protected_panes),
        trigger_id: trigger_id.clone(),
        result_file: result_file.clone(),
    };
    tokio::spawn(super::super::monitor::monitor_pane(params));
}

/// Outcome for a non-tmux job that has already returned.
pub(super) struct RunOutcome<'a> {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: &'a str,
    pub stderr: &'a str,
    /// When the job errored, the stringified error (used as stderr in the notification).
    pub error: Option<&'a str>,
}

/// Finalize a non-tmux job: update status + history, send the notification,
/// and (for trigger-initiated runs) push the trigger result.
#[allow(clippy::too_many_arguments)]
pub(super) async fn finalize_run(
    job: &Job,
    ctx: &JobContext,
    run_id: &str,
    trigger_id: &Option<String>,
    result_file: &Option<std::path::PathBuf>,
    telegram_config: &Option<TelegramConfig>,
    outcome: RunOutcome<'_>,
) {
    let finished_at = Utc::now().to_rfc3339();

    if outcome.success {
        log::info!(
            "[{}] Job '{}' finished with exit code {:?}",
            run_id,
            job.name,
            outcome.exit_code
        );
    } else if let Some(err) = outcome.error {
        log::error!("[{}] Job '{}' failed: {}", run_id, job.name, err);
    } else {
        log::info!(
            "[{}] Job '{}' finished with exit code {:?}",
            run_id,
            job.name,
            outcome.exit_code
        );
    }

    {
        let new_status = if outcome.success {
            JobStatus::Success {
                last_run: finished_at.clone(),
            }
        } else {
            JobStatus::Failed {
                last_run: finished_at.clone(),
                exit_code: outcome.exit_code.unwrap_or(-1),
            }
        };
        let mut status = ctx.job_status.lock();
        status.insert(job.slug.clone(), new_status.clone());
        drop(status);
        crate::relay::push_status_update(&ctx.relay, &job.slug, &new_status);
    }

    {
        let h = ctx.history.lock();
        let stderr_for_db = outcome.error.unwrap_or(outcome.stderr);
        if let Err(e) =
            h.update_finished(run_id, &finished_at, outcome.exit_code, outcome.stdout, stderr_for_db)
        {
            log::error!("Failed to update run record: {}", e);
        }
    }

    match job.notify_target {
        NotifyTarget::Telegram => {
            if let Some(ref tg) = telegram_config {
                let stderr_for_msg = outcome.error.unwrap_or(outcome.stderr);
                send_job_notification(
                    tg,
                    job.telegram_chat_id,
                    &job.name,
                    outcome.exit_code,
                    outcome.success,
                    outcome.stdout,
                    stderr_for_msg,
                )
                .await;
            }
        }
        NotifyTarget::App => {
            let event = if outcome.success { "completed" } else { "failed" };
            crate::relay::push_job_notification(&ctx.relay, &job.slug, event, run_id);
            if let Some(ref n) = ctx.notifier {
                n.notify_job(&job.name, event);
            }
        }
        NotifyTarget::None => {}
    }

    if let Some(tid) = trigger_id {
        if outcome.success {
            let parsed = result_file
                .as_ref()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
            crate::relay::push_trigger_result(
                &ctx.relay,
                tid,
                "succeeded",
                outcome.exit_code,
                parsed,
                None,
            );
        } else {
            crate::relay::push_trigger_result(
                &ctx.relay,
                tid,
                "failed",
                outcome.exit_code.or(Some(-1)),
                None,
                outcome.error.map(|s| s.to_string()),
            );
        }
    }
}

