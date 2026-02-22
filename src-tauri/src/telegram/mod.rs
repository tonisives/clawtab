pub mod commands;
pub mod polling;
pub mod types;

use std::sync::atomic::{AtomicBool, Ordering};

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Tracks an active interactive agent session for a Telegram chat.
pub struct ActiveAgent {
    pub pane_id: String,
    pub tmux_session: String,
    pub run_id: String,
}

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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

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

/// Check if the bot has group privacy mode disabled (can_read_all_group_messages).
/// Returns true if the bot can read all group messages, false if privacy mode is on.
pub async fn can_read_group_messages(bot_token: &str) -> bool {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok();
    let client = match client {
        Some(c) => c,
        None => return true, // Assume OK if client fails
    };

    let url = format!("https://api.telegram.org/bot{}/getMe", bot_token);
    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return true,
    };

    #[derive(serde::Deserialize)]
    struct BotInfo {
        can_read_all_group_messages: Option<bool>,
    }
    #[derive(serde::Deserialize)]
    struct Response {
        ok: bool,
        result: Option<BotInfo>,
    }

    match resp.json::<Response>().await {
        Ok(r) if r.ok => r
            .result
            .and_then(|b| b.can_read_all_group_messages)
            .unwrap_or(true),
        _ => true,
    }
}

/// Send a message and return its message_id for later editing/deletion.
pub async fn send_message_returning_id(
    bot_token: &str,
    chat_id: i64,
    text: &str,
) -> Result<i64, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);

    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
        }))
        .send()
        .await
        .map_err(|e| format!("Telegram request failed: {}", e))?;

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))?;

    parsed["result"]["message_id"]
        .as_i64()
        .ok_or_else(|| format!("No message_id in response: {}", body))
}

/// Edit an existing message's text.
pub async fn edit_message_text(
    bot_token: &str,
    chat_id: i64,
    message_id: i64,
    text: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = format!(
        "https://api.telegram.org/bot{}/editMessageText",
        bot_token
    );

    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": "HTML",
        }))
        .send()
        .await
        .map_err(|e| format!("Telegram editMessageText failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Telegram editMessageText error: {}", body));
    }

    Ok(())
}

/// Delete a message by ID.
pub async fn delete_message(
    bot_token: &str,
    chat_id: i64,
    message_id: i64,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = format!(
        "https://api.telegram.org/bot{}/deleteMessage",
        bot_token
    );

    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id,
        }))
        .send()
        .await
        .map_err(|e| format!("Telegram deleteMessage failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Telegram deleteMessage error: {}", body));
    }

    Ok(())
}

/// Send a chat action (e.g. "typing") to show activity indicator.
pub async fn send_chat_action(
    bot_token: &str,
    chat_id: i64,
    action: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = format!(
        "https://api.telegram.org/bot{}/sendChatAction",
        bot_token
    );

    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "action": action,
        }))
        .send()
        .await
        .map_err(|e| format!("Telegram sendChatAction failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Telegram sendChatAction error: {}", body));
    }

    Ok(())
}

/// Answer a callback query (dismiss the loading spinner on the button).
pub async fn answer_callback_query(
    bot_token: &str,
    callback_query_id: &str,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = format!(
        "https://api.telegram.org/bot{}/answerCallbackQuery",
        bot_token
    );

    client
        .post(&url)
        .json(&serde_json::json!({
            "callback_query_id": callback_query_id,
        }))
        .send()
        .await
        .map_err(|e| format!("Telegram answerCallbackQuery failed: {}", e))?;

    Ok(())
}

/// Send a message with an inline keyboard. Each button sends its `callback_data`
/// as the text of the user's reply (via callback query handling in the poller).
/// `buttons` is a list of (label, callback_data) pairs, laid out one per row.
pub async fn send_message_with_inline_keyboard(
    bot_token: &str,
    chat_id: i64,
    text: &str,
    buttons: &[(String, String)],
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = format!("https://api.telegram.org/bot{}/sendMessage", bot_token);

    // Build inline keyboard: one button per row
    let keyboard: Vec<Vec<serde_json::Value>> = buttons
        .iter()
        .map(|(label, data)| {
            vec![serde_json::json!({
                "text": label,
                "callback_data": data,
            })]
        })
        .collect();

    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "reply_markup": {
                "inline_keyboard": keyboard,
            },
        }))
        .send()
        .await
        .map_err(|e| format!("Telegram request failed: {}", e))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Telegram sendMessage with keyboard error: {}", body));
    }

    Ok(())
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
