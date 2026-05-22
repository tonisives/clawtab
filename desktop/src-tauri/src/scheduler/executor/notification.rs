use crate::telegram::TelegramConfig;

use super::super::monitor::TelegramStream;

const TELEGRAM_MAX_MESSAGE: usize = 4096;
/// Slack for the surrounding HTML tags + status line so the body fits.
const TELEGRAM_BODY_RESERVED: usize = 30;

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
    if !should_notify(config, success) {
        return;
    }

    let text = build_message(job_id, exit_code, success, stdout, stderr);
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

/// Compose the full HTML message: status line + optional <pre>-wrapped output.
fn build_message(
    job_id: &str,
    exit_code: Option<i32>,
    success: bool,
    stdout: &str,
    stderr: &str,
) -> String {
    let status = if success { "completed" } else { "failed" };
    let code_str = exit_code
        .map(|c| format!(" (exit {})", c))
        .unwrap_or_default();

    let mut text = format!(
        "<b>ClawTab</b>: Job <code>{}</code> {}{}",
        job_id, status, code_str
    );

    let output = combine_output(stdout, stderr);
    if !output.is_empty() {
        let max_output = TELEGRAM_MAX_MESSAGE
            .saturating_sub(text.len())
            .saturating_sub(TELEGRAM_BODY_RESERVED);
        let body = truncate_for_telegram(&output, max_output);
        text.push_str(&format!("\n<pre>{}</pre>", body));
    }
    text
}

/// Join non-empty trimmed stdout/stderr with a newline, returning "" if both are blank.
fn combine_output(stdout: &str, stderr: &str) -> String {
    let out = stdout.trim();
    let err = stderr.trim();
    match (out.is_empty(), err.is_empty()) {
        (false, false) => format!("{}\n{}", out, err),
        (false, true) => out.to_string(),
        (true, false) => err.to_string(),
        (true, true) => String::new(),
    }
}

/// Strip ANSI, HTML-escape, and truncate to fit in a single Telegram message.
fn truncate_for_telegram(raw: &str, max_len: usize) -> String {
    let escaped = crate::telegram::strip_ansi(raw)
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    if escaped.len() > max_len {
        format!("{}...", &escaped[..max_len])
    } else {
        escaped
    }
}
