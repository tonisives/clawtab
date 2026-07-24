use crate::telegram::TelegramConfig;

use super::super::monitor::TelegramStream;

/// Build a TelegramStream for the monitor, using per-job chat_id or global chat_ids.
pub(super) fn build_telegram_stream(
    config: &Option<TelegramConfig>,
    job_chat_id: Option<i64>,
) -> Option<TelegramStream> {
    let config = config.as_ref()?;
    if !config.is_configured() {
        return None;
    }
    let chat_id = job_chat_id.or_else(|| config.chat_ids.first().copied())?;
    Some(TelegramStream {
        bot_token: config.bot_token.clone(),
        chat_id,
    })
}

/// Send telegram notification, routing to per-job chat_id if set.
pub(super) async fn send_job_notification(
    config: &TelegramConfig,
    job_chat_id: Option<i64>,
    group_name: &str,
    job_id: &str,
    exit_code: Option<i32>,
    success: bool,
) {
    if !should_notify(config, success) {
        return;
    }

    let status = if success { "finished" } else { "failed" };
    let text = crate::telegram::format_job_status_message(group_name, job_id, status, exit_code);
    let chat_ids = resolve_chat_ids(config, job_chat_id);

    for chat_id in chat_ids {
        if let Err(e) = crate::telegram::send_message(&config.bot_token, chat_id, &text).await {
            log::error!("Failed to send Telegram notification to {}: {}", chat_id, e);
        }
    }
}

/// Whether the given outcome should produce a notification under this config.
fn should_notify(config: &TelegramConfig, success: bool) -> bool {
    if !config.is_configured() {
        return false;
    }
    if success {
        config.notify_on_success
    } else {
        config.notify_on_failure
    }
}

/// Pick the destination chat IDs: per-job override wins, else the global list.
fn resolve_chat_ids(config: &TelegramConfig, job_chat_id: Option<i64>) -> Vec<i64> {
    if let Some(cid) = job_chat_id {
        vec![cid]
    } else {
        config.chat_ids.clone()
    }
}
