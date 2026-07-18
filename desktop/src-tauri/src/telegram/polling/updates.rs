//! Talks to the Telegram getUpdates HTTP endpoint and primes the long-poll
//! offset on startup.

use super::lock_or_log;
use super::AgentState;
use crate::telegram::telegram_request_error;
use crate::telegram::types::{TelegramResponse, Update};

/// Eat any pending updates from a previous instance so we don't replay them,
/// and capture the offset to use for the first real long-poll. Returns `None`
/// if telegram is unconfigured or the priming call kept failing.
pub(super) async fn prime_offset(state: &AgentState) -> Option<i64> {
    let config = lock_or_log(&state.settings, "settings").and_then(|s| s.telegram.clone())?;
    if !(config.agent_enabled && config.is_configured()) {
        return None;
    }

    match get_updates(&config.bot_token, None, 0).await {
        Ok(updates) => return updates.last().map(|u| u.update_id + 1),
        Err(_) => {
            // Retry once after a short delay (clears 409 conflict from a
            // sibling long-poll still draining).
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }

    get_updates(&config.bot_token, None, 0)
        .await
        .ok()
        .and_then(|updates| updates.last().map(|u| u.update_id + 1))
}

pub(super) async fn get_updates(
    bot_token: &str,
    offset: Option<i64>,
    timeout_secs: u64,
) -> Result<Vec<Update>, String> {
    let client = reqwest::Client::new();
    let url = format!("https://api.telegram.org/bot{}/getUpdates", bot_token);

    let mut params = serde_json::json!({
        "timeout": timeout_secs,
        "allowed_updates": ["message", "callback_query"],
    });

    if let Some(off) = offset {
        params["offset"] = serde_json::json!(off);
    }

    let resp = client
        .post(&url)
        .json(&params)
        .timeout(std::time::Duration::from_secs(timeout_secs + 5))
        .send()
        .await
        .map_err(|e| telegram_request_error("getUpdates", &e))?;

    let body: TelegramResponse<Vec<Update>> = resp
        .json()
        .await
        .map_err(|e| telegram_request_error("decode getUpdates response", &e))?;

    if !body.ok {
        let desc = body
            .description
            .unwrap_or_else(|| "unknown error".to_string());
        return Err(format!("Telegram API error: {}", desc));
    }

    Ok(body.result.unwrap_or_default())
}
