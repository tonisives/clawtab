use serde::Serialize;
use tauri::State;

use crate::telegram::TelegramConfig;
use crate::AppState;

#[derive(Serialize)]
pub struct BotInfo {
    pub username: String,
    pub id: i64,
}

#[tauri::command]
pub fn get_telegram_config(state: State<AppState>) -> Option<TelegramConfig> {
    let settings = state.settings.lock().unwrap();
    settings.telegram.clone()
}

#[tauri::command]
pub fn set_telegram_config(
    state: State<AppState>,
    config: Option<TelegramConfig>,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.telegram = config;
    settings.save()
}

#[tauri::command]
pub async fn test_telegram(bot_token: String, chat_id: i64) -> Result<(), String> {
    crate::telegram::test_connection(&bot_token, chat_id).await
}

#[tauri::command]
pub async fn validate_bot_token(bot_token: String) -> Result<BotInfo, String> {
    let url = format!("https://api.telegram.org/bot{}/getMe", bot_token);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err("Invalid bot token".to_string());
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        return Err("Telegram API returned error".to_string());
    }

    let result = body.get("result").ok_or("Missing result field")?;
    let username = result
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("Missing username")?
        .to_string();
    let id = result
        .get("id")
        .and_then(|v| v.as_i64())
        .ok_or("Missing id")?;

    Ok(BotInfo { username, id })
}

#[tauri::command]
pub async fn poll_telegram_updates(bot_token: String) -> Result<Option<i64>, String> {
    let url = format!(
        "https://api.telegram.org/bot{}/getUpdates?timeout=5&allowed_updates=[\"message\"]",
        bot_token
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Client error: {}", e))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err("Failed to poll updates".to_string());
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let updates = body
        .get("result")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Return the chat_id from the most recent message
    if let Some(last) = updates.last() {
        let chat_id = last
            .get("message")
            .and_then(|m| m.get("chat"))
            .and_then(|c| c.get("id"))
            .and_then(|id| id.as_i64());
        return Ok(chat_id);
    }

    Ok(None)
}
