use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::interval;
use uuid::Uuid;

use crate::error::AppError;
use crate::ws::{desktop, mobile};
use crate::AppState;

pub(super) const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
pub(super) const CLIENT_TIMEOUT: Duration = Duration::from_secs(90);
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
pub struct WsQuery {
    token: Option<String>,
    device_token: Option<String>,
}

pub(super) enum AuthResult {
    Mobile { user_id: Uuid },
    Desktop {
        user_id: Uuid,
        device_id: Uuid,
        device_name: String,
    },
}

pub async fn ws_handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let auth = authenticate(&state, &query).await?;

    let user_id = match &auth {
        AuthResult::Mobile { user_id } | AuthResult::Desktop { user_id, .. } => *user_id,
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
        let device: Option<(Uuid, Uuid, String)> = sqlx::query_as(
            "SELECT id, user_id, name FROM devices WHERE device_token = $1",
        )
        .bind(device_token)
        .fetch_optional(&state.pool)
        .await?;

        let (device_id, user_id, device_name) = device.ok_or(AppError::Unauthorized)?;

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
        AuthResult::Mobile { user_id } => mobile::run(state, socket, user_id).await,
        AuthResult::Desktop {
            user_id,
            device_id,
            device_name,
        } => desktop::run(state, socket, user_id, device_id, device_name).await,
    }
}

/// Reason the per-connection loop ended. The caller decides what to log.
#[derive(Clone, Copy)]
pub(super) enum LoopExit {
    Closed,
    Timeout,
    SendError,
}

/// Drives a single WebSocket connection: drains outbound `rx` to the socket,
/// dispatches inbound text frames via `on_text`, and runs ping/pong heartbeats.
///
/// Returns when the socket closes, errors, or times out. The caller handles
/// hub registration before and cleanup after.
pub(super) async fn run_session_loop<F, Fut>(
    socket: WebSocket,
    mut rx: mpsc::UnboundedReceiver<String>,
    mut on_text: F,
) -> LoopExit
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let (mut sink, mut stream) = socket.split();
    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    let mut last_pong = tokio::time::Instant::now();

    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                if !matches!(
                    tokio::time::timeout(SEND_TIMEOUT, sink.send(Message::Text(msg.into()))).await,
                    Ok(Ok(()))
                ) {
                    return LoopExit::SendError;
                }
            }
            Some(msg) = stream.next() => {
                match msg {
                    Ok(Message::Text(text)) => {
                        on_text(text.to_string()).await;
                    }
                    Ok(Message::Pong(_)) => {
                        last_pong = tokio::time::Instant::now();
                    }
                    Ok(Message::Close(_)) | Err(_) => return LoopExit::Closed,
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > CLIENT_TIMEOUT {
                    return LoopExit::Timeout;
                }
                if !matches!(
                    tokio::time::timeout(SEND_TIMEOUT, sink.send(Message::Ping(vec![].into()))).await,
                    Ok(Ok(()))
                ) {
                    return LoopExit::SendError;
                }
            }
        }
    }
}
