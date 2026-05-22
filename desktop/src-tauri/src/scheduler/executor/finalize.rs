use std::sync::Arc;

use chrono::Utc;

use crate::config::jobs::{Job, JobStatus, NotifyTarget};
use crate::job_context::JobContext;
use crate::telegram::{ActiveAgent, TelegramConfig};

use super::super::monitor::MonitorParams;
use super::notification::{build_telegram_stream, send_job_notification};
use super::TmuxHandle;

/// Per-run context computed once at the top of `execute_job` and passed to
/// the post-result helpers. Borrowed for the duration of the call, so all
/// fields are references / lightweight values.
pub(super) struct RunCtx<'a> {
    pub job: &'a Job,
    pub ctx: &'a JobContext,
    pub run_id: &'a str,
    pub started_at: &'a str,
    pub trigger_id: &'a Option<String>,
    pub result_file: &'a Option<std::path::PathBuf>,
    pub telegram_config: &'a Option<TelegramConfig>,
}

/// Wire up a freshly-spawned tmux pane: update Running status with pane info,
/// persist pane_id, register auto_yes + active_agents, then spawn the monitor.
/// Caller should return immediately after this; the monitor owns finalization.
pub(super) fn attach_monitor(
    rc: &RunCtx<'_>,
    handle: TmuxHandle,
    pane_tx: &mut Option<tokio::sync::oneshot::Sender<(String, String)>>,
    use_auto_yes: bool,
) {
    publish_running_status(rc, &handle);
    notify_pane_listener(pane_tx, &handle);
    persist_pane_id(rc, &handle);

    if rc.job.auto_yes && use_auto_yes {
        register_auto_yes(rc, &handle);
    }
    if rc.job.notify_target == NotifyTarget::Telegram {
        register_active_agent(rc, &handle);
    }

    let params = build_monitor_params(rc, handle);
    tokio::spawn(super::super::monitor::monitor_pane(params));
}

fn publish_running_status(rc: &RunCtx<'_>, handle: &TmuxHandle) {
    let new_status = JobStatus::Running {
        run_id: rc.run_id.to_string(),
        started_at: rc.started_at.to_string(),
        pane_id: Some(handle.pane_id.clone()),
        tmux_session: Some(handle.tmux_session.clone()),
    };
    let ctx = rc.ctx;
    let mut status = ctx.job_status.lock();
    status.insert(rc.job.slug.clone(), new_status.clone());
    drop(status);
    crate::relay::push_status_update(&ctx.relay, &rc.job.slug, &new_status);
}

fn notify_pane_listener(
    pane_tx: &mut Option<tokio::sync::oneshot::Sender<(String, String)>>,
    handle: &TmuxHandle,
) {
    if let Some(tx) = pane_tx.take() {
        let _ = tx.send((handle.pane_id.clone(), handle.tmux_session.clone()));
    }
}

fn persist_pane_id(rc: &RunCtx<'_>, handle: &TmuxHandle) {
    let h = rc.ctx.history.lock();
    let _ = h.update_pane_id(rc.run_id, &handle.pane_id);
}

fn register_auto_yes(rc: &RunCtx<'_>, handle: &TmuxHandle) {
    let mut panes = rc.ctx.auto_yes_panes.lock();
    panes.insert(handle.pane_id.clone());
    log::info!(
        "Auto-yes enabled for job '{}' pane '{}'",
        rc.job.name,
        handle.pane_id
    );
}

fn register_active_agent(rc: &RunCtx<'_>, handle: &TmuxHandle) {
    let chat_id = rc.job.telegram_chat_id.or_else(|| {
        rc.telegram_config
            .as_ref()
            .and_then(|c| c.chat_ids.first().copied())
    });
    let Some(chat_id) = chat_id else { return };

    let ctx = rc.ctx;
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
            run_id: rc.run_id.to_string(),
            job_id: rc.job.name.clone(),
        },
    );
    ctx.active_agents_notify.notify_waiters();
}

fn build_monitor_params(rc: &RunCtx<'_>, handle: TmuxHandle) -> MonitorParams {
    let job = rc.job;
    let ctx = rc.ctx;
    let telegram = if job.notify_target == NotifyTarget::Telegram {
        build_telegram_stream(rc.telegram_config, job.telegram_chat_id)
    } else {
        None
    };
    let notify_on_success = rc
        .telegram_config
        .as_ref()
        .map(|c| c.notify_on_success)
        .unwrap_or(true);

    MonitorParams {
        tmux_session: handle.tmux_session,
        pane_id: handle.pane_id,
        run_id: rc.run_id.to_string(),
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
        trigger_id: rc.trigger_id.clone(),
        result_file: rc.result_file.clone(),
    }
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
pub(super) async fn finalize_run(rc: &RunCtx<'_>, outcome: RunOutcome<'_>) {
    let finished_at = Utc::now().to_rfc3339();
    log_outcome(rc, &outcome);
    publish_terminal_status(rc, &outcome, &finished_at);
    record_history(rc, &outcome, &finished_at);
    dispatch_notification(rc, &outcome).await;
    if let Some(tid) = rc.trigger_id {
        push_trigger_result(rc, tid, &outcome);
    }
}

fn log_outcome(rc: &RunCtx<'_>, outcome: &RunOutcome<'_>) {
    if let Some(err) = outcome.error.filter(|_| !outcome.success) {
        log::error!("[{}] Job '{}' failed: {}", rc.run_id, rc.job.name, err);
    } else {
        log::info!(
            "[{}] Job '{}' finished with exit code {:?}",
            rc.run_id,
            rc.job.name,
            outcome.exit_code
        );
    }
}

fn publish_terminal_status(rc: &RunCtx<'_>, outcome: &RunOutcome<'_>, finished_at: &str) {
    let new_status = if outcome.success {
        JobStatus::Success { last_run: finished_at.to_string() }
    } else {
        JobStatus::Failed {
            last_run: finished_at.to_string(),
            exit_code: outcome.exit_code.unwrap_or(-1),
        }
    };
    let ctx = rc.ctx;
    let mut status = ctx.job_status.lock();
    status.insert(rc.job.slug.clone(), new_status.clone());
    drop(status);
    crate::relay::push_status_update(&ctx.relay, &rc.job.slug, &new_status);
}

fn record_history(rc: &RunCtx<'_>, outcome: &RunOutcome<'_>, finished_at: &str) {
    let h = rc.ctx.history.lock();
    let stderr_for_db = outcome.error.unwrap_or(outcome.stderr);
    if let Err(e) = h.update_finished(
        rc.run_id,
        finished_at,
        outcome.exit_code,
        outcome.stdout,
        stderr_for_db,
    ) {
        log::error!("Failed to update run record: {}", e);
    }
}

async fn dispatch_notification(rc: &RunCtx<'_>, outcome: &RunOutcome<'_>) {
    let job = rc.job;
    let ctx = rc.ctx;
    match job.notify_target {
        NotifyTarget::Telegram => {
            if let Some(ref tg) = rc.telegram_config {
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
            crate::relay::push_job_notification(&ctx.relay, &job.slug, event, rc.run_id);
            if let Some(ref n) = ctx.notifier {
                n.notify_job(&job.name, event);
            }
        }
        NotifyTarget::None => {}
    }
}

fn push_trigger_result(rc: &RunCtx<'_>, trigger_id: &str, outcome: &RunOutcome<'_>) {
    let relay = &rc.ctx.relay;
    if outcome.success {
        let parsed = rc
            .result_file
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
        crate::relay::push_trigger_result(relay, trigger_id, "succeeded", outcome.exit_code, parsed, None);
    } else {
        crate::relay::push_trigger_result(
            relay,
            trigger_id,
            "failed",
            outcome.exit_code.or(Some(-1)),
            None,
            outcome.error.map(|s| s.to_string()),
        );
    }
}
