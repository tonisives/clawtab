use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::settings::RelaySettings;
use crate::AppState;

const KEYCHAIN_DEVICE_TOKEN_KEY: &str = "relay_device_token";
const KEYCHAIN_ACCESS_TOKEN_KEY: &str = "relay_access_token";
const KEYCHAIN_REFRESH_TOKEN_KEY: &str = "relay_refresh_token";

#[derive(Serialize)]
pub struct RelayStatus {
    pub enabled: bool,
    pub connected: bool,
    pub subscription_required: bool,
    pub auth_expired: bool,
    pub configured: bool,
    pub server_url: String,
    pub device_name: String,
}

#[tauri::command]
pub fn get_relay_settings(state: State<AppState>) -> Option<RelaySettings> {
    let mut relay = state.settings.lock().unwrap().relay.clone();
    // Populate device_token from keychain if yaml field is empty
    if let Some(ref mut rs) = relay {
        if rs.device_token.is_empty() {
            if let Some(token) = state.secrets.lock().unwrap().get(KEYCHAIN_DEVICE_TOKEN_KEY) {
                rs.device_token = token.clone();
            }
        }
    }
    relay
}

#[tauri::command]
pub fn set_relay_settings(state: State<AppState>, settings: RelaySettings) -> Result<(), String> {
    let device_token = settings.device_token.clone();

    // Store device_token in keychain, save empty string in yaml
    if !device_token.is_empty() {
        state
            .secrets
            .lock()
            .unwrap()
            .set(KEYCHAIN_DEVICE_TOKEN_KEY, &device_token)?;
    }

    let mut s = state.settings.lock().unwrap();
    s.relay = Some(RelaySettings {
        device_token: String::new(),
        ..settings
    });
    s.save()
}

#[tauri::command]
pub fn get_relay_status(state: State<AppState>) -> RelayStatus {
    let settings = state.settings.lock().unwrap();
    let relay = settings.relay.clone().unwrap_or_default();
    drop(settings);
    let connected = state.relay.lock().map(|g| g.is_some()).unwrap_or(false);
    let subscription_required = *state
        .relay_sub_required
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let auth_expired = *state
        .relay_auth_expired
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let device_token_stored = !relay.device_token.is_empty()
        || state
            .secrets
            .lock()
            .unwrap()
            .get(KEYCHAIN_DEVICE_TOKEN_KEY)
            .map(|t| !t.is_empty())
            .unwrap_or(false);
    let configured = !relay.server_url.is_empty() && device_token_stored;

    RelayStatus {
        enabled: relay.enabled,
        connected,
        subscription_required,
        auth_expired,
        configured,
        server_url: relay.server_url,
        device_name: relay.device_name,
    }
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub server_url: String,
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub refresh_token: String,
}

#[tauri::command]
pub async fn relay_login(req: LoginRequest) -> Result<LoginResponse, String> {
    let url = format!("{}/auth/login", req.server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "email": req.email,
            "password": req.password,
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Login failed: {}", text));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    Ok(LoginResponse {
        access_token: body["access_token"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        refresh_token: body["refresh_token"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    })
}

#[derive(Deserialize)]
pub struct PairDeviceRequest {
    pub server_url: String,
    pub device_name: String,
}

#[derive(Serialize)]
pub struct PairDeviceResponse {
    pub device_id: String,
    pub device_token: String,
}

/// Error string prefix used when pairing fails due to auth (401 after refresh attempt).
/// Frontend detects this prefix to clear tokens and drop back to sign-in.
pub const ERR_UNAUTHORIZED_PREFIX: &str = "UNAUTHORIZED:";

#[tauri::command]
pub async fn relay_pair_device(
    state: State<'_, AppState>,
    req: PairDeviceRequest,
) -> Result<PairDeviceResponse, String> {
    let server_url = req.server_url.trim_end_matches('/').to_string();
    let url = format!("{}/devices/pair", server_url);

    let (access_token, refresh_token) = {
        let secrets = state.secrets.lock().unwrap();
        (
            secrets
                .get(KEYCHAIN_ACCESS_TOKEN_KEY)
                .cloned()
                .unwrap_or_default(),
            secrets
                .get(KEYCHAIN_REFRESH_TOKEN_KEY)
                .cloned()
                .unwrap_or_default(),
        )
    };
    if access_token.is_empty() {
        return Err(format!("{} No access token stored", ERR_UNAUTHORIZED_PREFIX));
    }

    let body = serde_json::json!({ "device_name": req.device_name });

    let val = match relay_request(
        reqwest::Method::POST,
        &url,
        &access_token,
        &refresh_token,
        &server_url,
        Some(body),
        &state,
    )
    .await
    {
        Ok(v) => {
            *state.relay_auth_expired.lock().unwrap() = false;
            v
        }
        Err(e) => {
            let lower = e.to_lowercase();
            if lower.contains("unauthorized") || lower.contains("token refresh failed") {
                *state.relay_auth_expired.lock().unwrap() = true;
                return Err(format!("{} {}", ERR_UNAUTHORIZED_PREFIX, e));
            }
            return Err(format!("Pairing failed: {}", e));
        }
    };

    Ok(PairDeviceResponse {
        device_id: val["device_id"].as_str().unwrap_or_default().to_string(),
        device_token: val["device_token"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    })
}

/// Clear all stored auth + device tokens. Used by the Sign Out button and by
/// the frontend after an UNAUTHORIZED response from /devices/pair.
#[tauri::command]
pub fn relay_sign_out(state: State<AppState>) -> Result<(), String> {
    let mut secrets = state.secrets.lock().unwrap();
    let _ = secrets.delete(KEYCHAIN_ACCESS_TOKEN_KEY);
    let _ = secrets.delete(KEYCHAIN_REFRESH_TOKEN_KEY);
    drop(secrets);
    *state.relay_auth_expired.lock().unwrap() = false;
    Ok(())
}

#[tauri::command]
pub fn relay_disconnect(state: State<AppState>) {
    if let Ok(guard) = state.relay.lock() {
        if let Some(handle) = guard.as_ref() {
            handle.disconnect();
        }
    }
}

/// Connect (or reconnect) to the relay server using the saved settings.
#[tauri::command]
pub fn relay_connect(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let settings = state.settings.lock().unwrap();
    let rs = settings
        .relay
        .as_ref()
        .ok_or("No relay settings configured")?;
    if rs.server_url.is_empty() {
        return Err("Relay server URL not configured".to_string());
    }

    let server_url = rs.server_url.clone();

    // Read device_token from yaml, fall back to keychain
    let device_token = if rs.device_token.is_empty() {
        drop(settings);
        state
            .secrets
            .lock()
            .unwrap()
            .get(KEYCHAIN_DEVICE_TOKEN_KEY)
            .cloned()
            .unwrap_or_default()
    } else {
        let token = rs.device_token.clone();
        drop(settings);
        token
    };

    if device_token.is_empty() {
        return Err("Device token not configured".to_string());
    }

    let settings = state.settings.lock().unwrap();
    let rs = settings.relay.as_ref().unwrap();
    let ws_url = if rs.server_url.starts_with("http") {
        rs.server_url.replacen("http", "ws", 1) + "/ws"
    } else {
        rs.server_url.clone()
    };
    drop(settings);

    // Clear subscription-required flag on manual connect
    *state.relay_sub_required.lock().unwrap() = false;

    let relay = Arc::clone(&state.relay);
    let relay_sub = Arc::clone(&state.relay_sub_required);
    let jobs_config = Arc::clone(&state.jobs_config);
    let job_status = Arc::clone(&state.job_status);
    let secrets = Arc::clone(&state.secrets);
    let history = Arc::clone(&state.history);
    let settings = Arc::clone(&state.settings);
    let active_agents = Arc::clone(&state.active_agents);
    let auto_yes_panes = Arc::clone(&state.auto_yes_panes);
    let pty_manager = Arc::clone(&state.pty_manager);

    tauri::async_runtime::spawn(async move {
        crate::relay::connect_loop(
            ws_url,
            device_token,
            server_url,
            relay,
            relay_sub,
            jobs_config,
            job_status,
            secrets,
            history,
            settings,
            active_agents,
            auto_yes_panes,
            pty_manager,
            std::sync::Arc::new(crate::events::TauriEventSink::new(app)),
        )
        .await;
    });

    Ok(())
}

#[tauri::command]
pub fn relay_save_tokens(
    state: State<AppState>,
    access_token: String,
    refresh_token: String,
) -> Result<(), String> {
    let mut secrets = state.secrets.lock().unwrap();
    secrets.set(KEYCHAIN_ACCESS_TOKEN_KEY, &access_token)?;
    secrets.set(KEYCHAIN_REFRESH_TOKEN_KEY, &refresh_token)?;
    Ok(())
}

#[tauri::command]
pub fn relay_get_pending_token(state: State<AppState>) -> Result<Option<String>, String> {
    let secrets = state.secrets.lock().unwrap();
    Ok(secrets
        .get(KEYCHAIN_ACCESS_TOKEN_KEY)
        .cloned()
        .filter(|t| !t.is_empty()))
}

#[derive(Serialize)]
pub struct SubscriptionCheckResult {
    pub subscribed: bool,
}

#[tauri::command]
pub async fn relay_check_subscription(
    state: State<'_, AppState>,
) -> Result<SubscriptionCheckResult, String> {
    let server_url = {
        let settings = state.settings.lock().unwrap();
        settings
            .relay
            .as_ref()
            .map(|r| r.server_url.clone())
            .unwrap_or_default()
    };
    if server_url.is_empty() {
        return Err("No relay server configured".to_string());
    }

    let (access_token, refresh_token_val) = {
        let secrets = state.secrets.lock().unwrap();
        (
            secrets
                .get(KEYCHAIN_ACCESS_TOKEN_KEY)
                .cloned()
                .unwrap_or_default(),
            secrets
                .get(KEYCHAIN_REFRESH_TOKEN_KEY)
                .cloned()
                .unwrap_or_default(),
        )
    };
    if access_token.is_empty() {
        return Err("No access token stored".to_string());
    }

    let result =
        crate::relay::check_subscription_http(&server_url, &access_token, &refresh_token_val).await;

    match result {
        Ok((subscribed, new_access, new_refresh)) => {
            // Save refreshed tokens if we got new ones
            if let (Some(at), Some(rt)) = (new_access, new_refresh) {
                let mut secrets = state.secrets.lock().unwrap();
                let _ = secrets.set(KEYCHAIN_ACCESS_TOKEN_KEY, &at);
                let _ = secrets.set(KEYCHAIN_REFRESH_TOKEN_KEY, &rt);
            }
            *state.relay_sub_required.lock().unwrap() = !subscribed;
            Ok(SubscriptionCheckResult { subscribed })
        }
        Err(e) => Err(e),
    }
}

// --- Share management ---

#[derive(Serialize, Deserialize)]
pub struct ShareInfo {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub allowed_groups: Option<Vec<String>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
pub struct SharedWithMeInfo {
    pub id: String,
    pub owner_email: String,
    pub owner_display_name: Option<String>,
    pub allowed_groups: Option<Vec<String>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize, Deserialize)]
pub struct SharesResponse {
    pub shared_by_me: Vec<ShareInfo>,
    pub shared_with_me: Vec<SharedWithMeInfo>,
}

/// Helper to get server_url and access_token from state.
fn get_relay_auth(state: &AppState) -> Result<(String, String, String), String> {
    let server_url = {
        let settings = state.settings.lock().unwrap();
        settings
            .relay
            .as_ref()
            .map(|r| r.server_url.clone())
            .unwrap_or_default()
    };
    if server_url.is_empty() {
        return Err("No relay server configured".to_string());
    }
    let (access_token, refresh_token) = {
        let secrets = state.secrets.lock().unwrap();
        (
            secrets
                .get(KEYCHAIN_ACCESS_TOKEN_KEY)
                .cloned()
                .unwrap_or_default(),
            secrets
                .get(KEYCHAIN_REFRESH_TOKEN_KEY)
                .cloned()
                .unwrap_or_default(),
        )
    };
    if access_token.is_empty() {
        return Err("No access token stored".to_string());
    }
    Ok((server_url, access_token, refresh_token))
}

/// Make an authenticated GET/POST/PATCH/DELETE to the relay server with auto-refresh.
async fn relay_request(
    method: reqwest::Method,
    url: &str,
    access_token: &str,
    refresh_token: &str,
    server_url: &str,
    body: Option<serde_json::Value>,
    state: &AppState,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();

    let mut req = client
        .request(method.clone(), url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("Content-Type", "application/json");
    if let Some(ref b) = body {
        req = req.json(b);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if resp.status().as_u16() == 401 && !refresh_token.is_empty() {
        let refresh_url = format!("{}/auth/refresh", server_url.trim_end_matches('/'));
        let refresh_resp = client
            .post(&refresh_url)
            .json(&serde_json::json!({ "refresh_token": refresh_token }))
            .send()
            .await
            .map_err(|e| format!("Refresh failed: {}", e))?;

        if !refresh_resp.status().is_success() {
            return Err("Token refresh failed".to_string());
        }

        let rb: serde_json::Value = refresh_resp
            .json()
            .await
            .map_err(|e| format!("Invalid refresh response: {}", e))?;
        let new_access = rb["access_token"].as_str().unwrap_or_default().to_string();
        let new_refresh = rb["refresh_token"].as_str().unwrap_or_default().to_string();

        // Save refreshed tokens
        {
            let mut secrets = state.secrets.lock().unwrap();
            let _ = secrets.set(KEYCHAIN_ACCESS_TOKEN_KEY, &new_access);
            let _ = secrets.set(KEYCHAIN_REFRESH_TOKEN_KEY, &new_refresh);
        }

        let mut retry = client
            .request(method, url)
            .header("Authorization", format!("Bearer {}", new_access))
            .header("Content-Type", "application/json");
        if let Some(ref b) = body {
            retry = retry.json(b);
        }
        let retry_resp = retry
            .send()
            .await
            .map_err(|e| format!("Retry request failed: {}", e))?;

        if !retry_resp.status().is_success() {
            let text = retry_resp.text().await.unwrap_or_default();
            return Err(extract_error_message(&text, "Request failed"));
        }
        return retry_resp
            .json()
            .await
            .map_err(|e| format!("Invalid response: {}", e));
    }

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(extract_error_message(&text, "Request failed"));
    }

    resp.json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

fn extract_error_message(text: &str, fallback: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(e) = v["error"].as_str() {
            return e.to_string();
        }
        if let Some(m) = v["message"].as_str() {
            return m.to_string();
        }
    }
    if text.is_empty() {
        fallback.to_string()
    } else {
        text.to_string()
    }
}

#[tauri::command]
pub async fn relay_get_shares(state: State<'_, AppState>) -> Result<SharesResponse, String> {
    let (server_url, access_token, refresh_token) = get_relay_auth(&state)?;
    let url = format!("{}/shares", server_url.trim_end_matches('/'));
    let val = relay_request(
        reqwest::Method::GET,
        &url,
        &access_token,
        &refresh_token,
        &server_url,
        None,
        &state,
    )
    .await?;
    serde_json::from_value(val).map_err(|e| format!("Invalid shares response: {}", e))
}

#[tauri::command]
pub async fn relay_add_share(
    state: State<'_, AppState>,
    email: String,
    allowed_groups: Option<Vec<String>>,
) -> Result<ShareInfo, String> {
    let (server_url, access_token, refresh_token) = get_relay_auth(&state)?;
    let url = format!("{}/shares", server_url.trim_end_matches('/'));
    let body = serde_json::json!({ "email": email, "allowed_groups": allowed_groups });
    let val = relay_request(
        reqwest::Method::POST,
        &url,
        &access_token,
        &refresh_token,
        &server_url,
        Some(body),
        &state,
    )
    .await?;
    serde_json::from_value(val).map_err(|e| format!("Invalid share response: {}", e))
}

#[tauri::command]
pub async fn relay_update_share(
    state: State<'_, AppState>,
    share_id: String,
    allowed_groups: Option<Vec<String>>,
) -> Result<(), String> {
    let (server_url, access_token, refresh_token) = get_relay_auth(&state)?;
    let url = format!("{}/shares/{}", server_url.trim_end_matches('/'), share_id);
    let body = serde_json::json!({ "allowed_groups": allowed_groups });
    relay_request(
        reqwest::Method::PATCH,
        &url,
        &access_token,
        &refresh_token,
        &server_url,
        Some(body),
        &state,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn relay_remove_share(
    state: State<'_, AppState>,
    share_id: String,
) -> Result<(), String> {
    let (server_url, access_token, refresh_token) = get_relay_auth(&state)?;
    let url = format!("{}/shares/{}", server_url.trim_end_matches('/'), share_id);
    relay_request(
        reqwest::Method::DELETE,
        &url,
        &access_token,
        &refresh_token,
        &server_url,
        None,
        &state,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub fn relay_get_groups(state: State<AppState>) -> Vec<String> {
    let config = state.jobs_config.lock().unwrap();
    let mut groups: Vec<String> = config
        .jobs
        .iter()
        .map(|j| j.group.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    groups.sort();
    groups
}
