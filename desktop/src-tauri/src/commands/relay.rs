use std::sync::Arc;

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
        state.secrets.lock().unwrap().set(KEYCHAIN_DEVICE_TOKEN_KEY, &device_token)?;
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
    let connected = state.relay.lock().map(|g| g.is_some()).unwrap_or(false);
    let subscription_required = *state.relay_sub_required.lock().unwrap_or_else(|e| e.into_inner());
    RelayStatus {
        enabled: relay.enabled,
        connected,
        subscription_required,
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
    pub access_token: String,
    pub device_name: String,
}

#[derive(Serialize)]
pub struct PairDeviceResponse {
    pub device_id: String,
    pub device_token: String,
}

#[tauri::command]
pub async fn relay_pair_device(req: PairDeviceRequest) -> Result<PairDeviceResponse, String> {
    let url = format!("{}/devices/pair", req.server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", req.access_token))
        .json(&serde_json::json!({
            "device_name": req.device_name,
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Pairing failed: {}", text));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid response: {}", e))?;

    Ok(PairDeviceResponse {
        device_id: body["device_id"].as_str().unwrap_or_default().to_string(),
        device_token: body["device_token"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    })
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
pub fn relay_connect(state: State<AppState>) -> Result<(), String> {
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
        state.secrets.lock().unwrap()
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
            secrets.get(KEYCHAIN_ACCESS_TOKEN_KEY).cloned().unwrap_or_default(),
            secrets.get(KEYCHAIN_REFRESH_TOKEN_KEY).cloned().unwrap_or_default(),
        )
    };
    if access_token.is_empty() {
        return Err("No access token stored".to_string());
    }

    let result = crate::relay::check_subscription_http(
        &server_url,
        &access_token,
        &refresh_token_val,
    )
    .await;

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
