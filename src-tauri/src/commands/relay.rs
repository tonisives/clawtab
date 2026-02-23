use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::config::settings::RelaySettings;
use crate::AppState;

#[derive(Serialize)]
pub struct RelayStatus {
    pub enabled: bool,
    pub connected: bool,
    pub server_url: String,
    pub device_name: String,
}

#[tauri::command]
pub fn get_relay_settings(state: State<AppState>) -> Option<RelaySettings> {
    state.settings.lock().unwrap().relay.clone()
}

#[tauri::command]
pub fn set_relay_settings(state: State<AppState>, settings: RelaySettings) -> Result<(), String> {
    let mut s = state.settings.lock().unwrap();
    s.relay = Some(settings);
    s.save()
}

#[tauri::command]
pub fn get_relay_status(state: State<AppState>) -> RelayStatus {
    let settings = state.settings.lock().unwrap();
    let relay = settings.relay.clone().unwrap_or_default();
    let connected = state.relay.lock().map(|g| g.is_some()).unwrap_or(false);
    RelayStatus {
        enabled: relay.enabled,
        connected,
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
    if rs.server_url.is_empty() || rs.device_token.is_empty() {
        return Err("Relay server URL or device token not configured".to_string());
    }

    let ws_url = if rs.server_url.starts_with("http") {
        rs.server_url.replacen("http", "ws", 1) + "/ws"
    } else {
        rs.server_url.clone()
    };
    let device_token = rs.device_token.clone();
    drop(settings);

    let relay = Arc::clone(&state.relay);
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
            relay,
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
