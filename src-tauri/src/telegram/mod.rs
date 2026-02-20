pub mod commands;
pub mod polling;
pub mod types;

use std::sync::atomic::{AtomicBool, Ordering};

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

const MAX_MESSAGE_LEN: usize = 4096;

/// When true, the agent poller yields to the setup poller so they don't compete
/// for getUpdates from the same bot.
static SETUP_POLLING_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_setup_polling(active: bool) {
    SETUP_POLLING_ACTIVE.store(active, Ordering::Relaxed);
}

pub fn is_setup_polling() -> bool {
    SETUP_POLLING_ACTIVE.load(Ordering::Relaxed)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TelegramConfig {
    pub bot_token: String,
    pub chat_ids: Vec<i64>,
    pub chat_names: HashMap<String, String>,
    pub notify_on_success: bool,
    pub notify_on_failure: bool,
    pub agent_enabled: bool,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            bot_token: String::new(),
            chat_ids: Vec::new(),
            chat_names: HashMap::new(),
            notify_on_success: true,
            notify_on_failure: true,
            agent_enabled: false,
        }
    }
}

impl TelegramConfig {
    pub fn is_configured(&self) -> bool {
        !self.bot_token.is_empty() && !self.chat_ids.is_empty()
    }
}

/// Send a message to a specific chat. Splits long messages into chunks.
pub async fn send_message(
    bot_token: &str,
    chat_id: i64,
    text: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    // Split into chunks if the message is too long
    let chunks = split_message(text);

    for chunk in chunks {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);

        let resp = client
            .post(&url)
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "text": chunk,
                "parse_mode": "HTML",
            }))
            .send()
            .await
            .map_err(|e| format!("Telegram request failed: {}", e))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Telegram API error: {}", body));
        }
    }

    Ok(())
}

/// Send a notification to all configured chat IDs
pub async fn notify(config: &TelegramConfig, text: &str) {
    if !config.is_configured() {
        return;
    }

    for &chat_id in &config.chat_ids {
        if let Err(e) = send_message(&config.bot_token, chat_id, text).await {
            log::error!("Failed to send Telegram notification to {}: {}", chat_id, e);
        }
    }
}

/// Send a job completion notification
pub async fn notify_job_result(
    config: &TelegramConfig,
    job_name: &str,
    exit_code: Option<i32>,
    success: bool,
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

    let text = format!(
        "<b>ClawTab</b>: Job <code>{}</code> {}{}",
        job_name, status, code_str
    );

    notify(config, &text).await;
}

/// Test the bot connection by sending a test message
pub async fn test_connection(bot_token: &str, chat_id: i64) -> Result<(), String> {
    send_message(bot_token, chat_id, "ClawTab test message - connection successful.").await
}

fn split_message(text: &str) -> Vec<String> {
    if text.len() <= MAX_MESSAGE_LEN {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        if remaining.len() <= MAX_MESSAGE_LEN {
            chunks.push(remaining.to_string());
            break;
        }

        // Find a good split point (newline before the limit)
        let split_at = remaining[..MAX_MESSAGE_LEN]
            .rfind('\n')
            .unwrap_or(MAX_MESSAGE_LEN);

        chunks.push(remaining[..split_at].to_string());
        remaining = &remaining[split_at..].trim_start_matches('\n');
    }

    chunks
}
