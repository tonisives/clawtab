use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::interval;
use uuid::Uuid;

use clawtab_protocol::{error_codes, ClientMessage, DesktopMessage, ServerMessage};

use crate::error::AppError;
use crate::ws::hub::{DesktopConnection, MobileConnection};
use crate::AppState;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Deserialize)]
pub struct WsQuery {
    token: Option<String>,
    device_token: Option<String>,
}

enum AuthResult {
    Mobile { user_id: Uuid },
    Desktop { user_id: Uuid, device_id: Uuid, device_name: String },
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let auth = authenticate(&state, &query).await?;

    // Subscription gate: check if user has active subscription
    let user_id = match &auth {
        AuthResult::Mobile { user_id } => *user_id,
        AuthResult::Desktop { user_id, .. } => *user_id,
    };
    if !crate::billing::is_subscribed(&state.pool, &state.config, user_id).await? {
        return Err(AppError::Forbidden);
    }

    Ok(ws.on_upgrade(move |socket| handle_socket(state, socket, auth)))
}

async fn authenticate(state: &AppState, query: &WsQuery) -> Result<AuthResult, AppError> {
    if let Some(token) = &query.token {
        let claims = crate::auth::validate_access_token(token, &state.config.jwt_secret)?;
        return Ok(AuthResult::Mobile { user_id: claims.sub });
    }

    if let Some(device_token) = &query.device_token {
        let device = sqlx::query_as::<_, (Uuid, Uuid, String)>(
            "SELECT id, user_id, name FROM devices WHERE device_token = $1"
        )
        .bind(device_token)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .ok_or(AppError::Unauthorized)?;

        let (device_id, user_id, device_name) = device;

        sqlx::query("UPDATE devices SET last_seen = now() WHERE id = $1")
            .bind(device_id)
            .execute(&state.pool)
            .await
            .ok();

        return Ok(AuthResult::Desktop {
            user_id,
            device_id,
            device_name,
        });
    }

    Err(AppError::Unauthorized)
}

async fn handle_socket(state: AppState, socket: WebSocket, auth: AuthResult) {
    match auth {
        AuthResult::Mobile { user_id } => handle_mobile(state, socket, user_id).await,
        AuthResult::Desktop { user_id, device_id, device_name } => {
            handle_desktop(state, socket, user_id, device_id, device_name).await;
        }
    }
}

#[allow(clippy::cognitive_complexity)]
async fn handle_mobile(state: AppState, socket: WebSocket, user_id: Uuid) {
    let connection_id = Uuid::new_v4();
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    {
        let mut hub = state.hub.write().await;
        hub.add_mobile(user_id, MobileConnection { connection_id, tx: tx.clone() });
    }

    let Ok(welcome) = serde_json::to_string(&ServerMessage::Welcome {
        connection_id: connection_id.to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
    }) else {
        return;
    };
    let _ = tx.send(welcome);

    tracing::info!("mobile connected: user={user_id} conn={connection_id}");

    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    let mut last_pong = tokio::time::Instant::now();

    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                if ws_sink.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            Some(msg) = ws_stream.next() => {
                match msg {
                    Ok(Message::Text(text)) => {
                        handle_mobile_message(&state, user_id, &text).await;
                    }
                    Ok(Message::Pong(_)) => {
                        last_pong = tokio::time::Instant::now();
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > CLIENT_TIMEOUT {
                    tracing::info!("mobile timed out: conn={connection_id}");
                    break;
                }
                if ws_sink.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
            }
        }
    }

    {
        let mut hub = state.hub.write().await;
        hub.remove_mobile(user_id, connection_id);
    }
    tracing::info!("mobile disconnected: conn={connection_id}");
}

async fn handle_mobile_message(state: &AppState, user_id: Uuid, text: &str) {
    let Ok(msg) = serde_json::from_str::<ClientMessage>(text) else {
        tracing::warn!("invalid message from mobile: {text}");
        return;
    };

    let hub = state.hub.read().await;

    if !hub.has_desktop(user_id) {
        let error = ServerMessage::Error {
            id: extract_id(&msg),
            code: error_codes::DESKTOP_OFFLINE.into(),
            message: "your desktop app is not connected".into(),
        };
        if let Ok(json) = serde_json::to_string(&error) {
            hub.send_raw_to_mobiles(user_id, &json);
        }
        return;
    }

    hub.forward_to_desktop(user_id, &msg);
}

#[allow(clippy::cognitive_complexity)]
async fn handle_desktop(
    state: AppState,
    socket: WebSocket,
    user_id: Uuid,
    device_id: Uuid,
    device_name: String,
) {
    let (mut ws_sink, mut ws_stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    {
        let mut hub = state.hub.write().await;
        hub.add_desktop(user_id, DesktopConnection {
            device_id,
            device_name: device_name.clone(),
            tx: tx.clone(),
        });
    }

    let Ok(welcome) = serde_json::to_string(&ServerMessage::Welcome {
        connection_id: device_id.to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
    }) else {
        return;
    };
    let _ = tx.send(welcome);

    tracing::info!("desktop connected: user={user_id} device={device_id} name={device_name}");

    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    let mut last_pong = tokio::time::Instant::now();

    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                if ws_sink.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            Some(msg) = ws_stream.next() => {
                match msg {
                    Ok(Message::Text(text)) => {
                        handle_desktop_message(&state, user_id, &text).await;
                    }
                    Ok(Message::Pong(_)) => {
                        last_pong = tokio::time::Instant::now();
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > CLIENT_TIMEOUT {
                    tracing::info!("desktop timed out: device={device_id}");
                    break;
                }
                if ws_sink.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
            }
        }
    }

    {
        let mut hub = state.hub.write().await;
        hub.remove_desktop(user_id, device_id);
    }

    sqlx::query("UPDATE devices SET last_seen = now() WHERE id = $1")
        .bind(device_id)
        .execute(&state.pool)
        .await
        .ok();

    tracing::info!("desktop disconnected: device={device_id}");
}

async fn handle_desktop_message(state: &AppState, user_id: Uuid, text: &str) {
    // Validate it parses as a DesktopMessage
    let Ok(_msg) = serde_json::from_str::<DesktopMessage>(text) else {
        tracing::warn!("invalid message from desktop: {text}");
        return;
    };

    // Forward raw JSON to all mobile clients (avoids re-serialization)
    let hub = state.hub.read().await;
    hub.send_raw_to_mobiles(user_id, text);
}

fn extract_id(msg: &ClientMessage) -> Option<String> {
    match msg {
        ClientMessage::ListJobs { id, .. }
        | ClientMessage::RunJob { id, .. }
        | ClientMessage::PauseJob { id, .. }
        | ClientMessage::ResumeJob { id, .. }
        | ClientMessage::StopJob { id, .. }
        | ClientMessage::SendInput { id, .. }
        | ClientMessage::SubscribeLogs { id, .. }
        | ClientMessage::GetRunHistory { id, .. }
        | ClientMessage::RunAgent { id, .. }
        | ClientMessage::CreateJob { id, .. }
        | ClientMessage::DetectProcesses { id, .. }
        | ClientMessage::GetRunDetail { id, .. } => Some(id.clone()),
        ClientMessage::UnsubscribeLogs { .. } => None,
    }
}
