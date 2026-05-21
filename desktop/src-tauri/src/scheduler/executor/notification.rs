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
    job_id: &str,
    exit_code: Option<i32>,
    success: bool,
    stdout: &str,
    stderr: &str,
) {
    if !config.is_configured() {
        return;
    }

    if success && !config.notify_on_success {
        return;
    }
    if !success && !config.notify_on_failure {
        return;
    }

    let status = if success { "completed" } else { "failed" };
    let code_str = exit_code
        .map(|c| format!(" (exit {})", c))
        .unwrap_or_default();

    let mut text = format!(
        "<b>ClawTab</b>: Job <code>{}</code> {}{}",
        job_id, status, code_str
    );

    let output = if !stdout.trim().is_empty() && !stderr.trim().is_empty() {
        format!("{}\n{}", stdout.trim(), stderr.trim())
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else {
        String::new()
    };

    if !output.is_empty() {
        let escaped = crate::telegram::strip_ansi(&output)
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let max_output = 4096 - text.len() - 30;
        let truncated = if escaped.len() > max_output {
            format!("{}...", &escaped[..max_output])
        } else {
            escaped
        };
        text.push_str(&format!("\n<pre>{}</pre>", truncated));
    }

    let chat_ids: Vec<i64> = if let Some(cid) = job_chat_id {
        vec![cid]
    } else {
        config.chat_ids.clone()
    };

    for chat_id in chat_ids {
        if let Err(e) = crate::telegram::send_message(&config.bot_token, chat_id, &text).await {
            log::error!("Failed to send Telegram notification to {}: {}", chat_id, e);
        }
    }
}
