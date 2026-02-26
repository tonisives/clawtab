use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::interval;
use uuid::Uuid;

use clawtab_protocol::{error_codes, ClientMessage, DesktopMessage, ServerMessage, ClaudeQuestion};

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

    // Handle relay-intercepted messages (not forwarded to desktop)
    match &msg {
        ClientMessage::RegisterPushToken {
            id,
            push_token,
            platform,
        } => {
            handle_register_push_token(state, user_id, id, push_token, platform).await;
            return;
        }
        ClientMessage::GetNotificationHistory { id, limit } => {
            handle_get_notification_history(state, user_id, id, *limit).await;
            return;
        }
        _ => {}
    }

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

    // AnswerQuestion: forward to desktop AND mark as answered in DB
    if let ClientMessage::AnswerQuestion {
        question_id,
        answer,
        ..
    } = &msg
    {
        let qid = question_id.clone();
        let ans = answer.clone();
        let pool = state.pool.clone();
        tokio::spawn(async move {
            sqlx::query(
                "UPDATE notification_history SET answered = true, answered_with = $1 WHERE question_id = $2",
            )
            .bind(&ans)
            .bind(&qid)
            .execute(&pool)
            .await
            .ok();
        });
    }

    hub.forward_to_desktop(user_id, &msg);
}

async fn handle_register_push_token(
    state: &AppState,
    user_id: Uuid,
    id: &str,
    push_token: &str,
    platform: &str,
) {
    let result = sqlx::query(
        "INSERT INTO push_tokens (user_id, push_token, platform)
         VALUES ($1, $2, $3)
         ON CONFLICT (push_token)
         DO UPDATE SET user_id = $1, platform = $3, updated_at = now()",
    )
    .bind(user_id)
    .bind(push_token)
    .bind(platform)
    .execute(&state.pool)
    .await;

    let success = result.is_ok();
    if let Err(ref e) = result {
        tracing::error!("failed to save push token: {e}");
    }

    // Send ack back to mobile
    let ack = serde_json::json!({
        "type": "register_push_token_ack",
        "id": id,
        "success": success,
    });
    if let Ok(json) = serde_json::to_string(&ack) {
        let hub = state.hub.read().await;
        hub.send_raw_to_mobiles(user_id, &json);
    }
}

async fn handle_get_notification_history(
    state: &AppState,
    user_id: Uuid,
    id: &str,
    limit: u32,
) {
    let limit = limit.min(50) as i64;
    let rows: Vec<(String, String, String, String, serde_json::Value, bool, Option<String>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT question_id, pane_id, cwd, context_lines, options, answered, answered_with, created_at
         FROM notification_history
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let notifications: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(question_id, pane_id, cwd, context_lines, options, answered, answered_with, created_at)| {
            serde_json::json!({
                "question_id": question_id,
                "pane_id": pane_id,
                "cwd": cwd,
                "context_lines": context_lines,
                "options": options,
                "answered": answered,
                "answered_with": answered_with,
                "created_at": created_at.to_rfc3339(),
            })
        })
        .collect();

    let resp = serde_json::json!({
        "type": "notification_history",
        "id": id,
        "notifications": notifications,
    });
    if let Ok(json) = serde_json::to_string(&resp) {
        let hub = state.hub.read().await;
        hub.send_raw_to_mobiles(user_id, &json);
    }
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
    let Ok(msg) = serde_json::from_str::<DesktopMessage>(text) else {
        tracing::warn!("invalid message from desktop: {text}");
        return;
    };

    // Forward raw JSON to all mobile clients (avoids re-serialization)
    let hub = state.hub.read().await;
    hub.send_raw_to_mobiles(user_id, text);

    // If this is a ClaudeQuestions message, trigger push notifications
    if let DesktopMessage::ClaudeQuestions { ref questions } = msg {
        if !questions.is_empty() {
            let state = state.clone();
            let questions = questions.clone();
            tokio::spawn(async move {
                handle_claude_questions_push(&state, user_id, &questions).await;
            });
        }
    }
}

async fn handle_claude_questions_push(
    state: &AppState,
    user_id: Uuid,
    questions: &[ClaudeQuestion],
) {
    // Rate limit check (per-user cooldown)
    if let Some(ref redis) = state.redis {
        let mut conn = redis.clone();
        if !crate::push_limiter::allow_push(
            &mut conn,
            user_id,
            state.config.push_rate_limit_seconds,
        )
        .await
        {
            tracing::debug!("push rate limited for user {user_id}");
            return;
        }

        // Per-question dedup: skip if we already pushed for this question
        let q_id = &questions[0].question_id;
        if crate::push_limiter::is_question_pushed(&mut conn, q_id).await {
            tracing::debug!("push already sent for question {q_id}");
            return;
        }
    }

    // Save to notification_history
    for q in questions {
        let options_json = serde_json::to_value(&q.options).unwrap_or_default();
        sqlx::query(
            "INSERT INTO notification_history (user_id, question_id, pane_id, cwd, context_lines, options)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (question_id) DO NOTHING",
        )
        .bind(user_id)
        .bind(&q.question_id)
        .bind(&q.pane_id)
        .bind(&q.cwd)
        .bind(&q.context_lines)
        .bind(&options_json)
        .execute(&state.pool)
        .await
        .ok();
    }

    // Send push notifications
    let Some(ref apns) = state.apns else {
        return;
    };

    // Get user's push tokens
    let tokens: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, push_token FROM push_tokens WHERE user_id = $1 AND platform = 'ios'",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    if tokens.is_empty() {
        return;
    }

    // Use the first question for the push notification
    let q = &questions[0];
    let project = q
        .cwd
        .rsplit('/')
        .next()
        .unwrap_or(&q.cwd);

    let title = format!("Claude needs input - {project}");
    let body = {
        // Extract the question text from context_lines by stripping decorative
        // lines and keeping only meaningful content.
        let question_text: Vec<&str> = q
            .context_lines
            .lines()
            .filter(|l| {
                let t = l.trim();
                if t.is_empty() {
                    return false;
                }
                // Skip lines made entirely of box-drawing / decoration chars
                !t.chars().all(|c| {
                    matches!(c,
                        '-' | '_' | '=' | '~' | '\u{2501}' | '\u{2500}' | '\u{2550}'
                        | '\u{254C}' | '\u{254D}' | '\u{2504}' | '\u{2505}'
                        | '\u{2508}' | '\u{2509}' | '\u{2574}' | '\u{2576}'
                        | '\u{2578}' | '\u{257A}' | '\u{2594}' | '\u{2581}'
                        | '|' | '\u{2502}' | '\u{2503}' | ' '
                    )
                })
            })
            .collect();

        let options_str = q
            .options
            .iter()
            .map(|o| format!("{}. {}", o.number, o.label))
            .collect::<Vec<_>>()
            .join(" | ");

        if question_text.is_empty() {
            options_str
        } else {
            let ctx = question_text.join("\n");
            if options_str.is_empty() {
                ctx
            } else {
                format!("{ctx}\n{options_str}")
            }
        }
    };

    let options: Vec<(String, String)> = q
        .options
        .iter()
        .map(|o| (o.number.clone(), o.label.clone()))
        .collect();

    let mut invalid_token_ids = Vec::new();

    for (token_id, device_token) in &tokens {
        match apns
            .send_question_notification(device_token, &title, &body, &q.question_id, &q.pane_id, q.matched_job.as_deref(), &options)
            .await
        {
            Ok(()) => {
                tracing::info!("push sent to {device_token}");
            }
            Err(e) if e.starts_with("invalid_token:") => {
                tracing::warn!("removing invalid push token: {device_token}");
                invalid_token_ids.push(*token_id);
            }
            Err(e) => {
                tracing::error!("push failed: {e}");
            }
        }
    }

    // Clean up invalid tokens
    for token_id in invalid_token_ids {
        sqlx::query("DELETE FROM push_tokens WHERE id = $1")
            .bind(token_id)
            .execute(&state.pool)
            .await
            .ok();
    }
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
        | ClientMessage::GetRunDetail { id, .. }
        | ClientMessage::GetDetectedProcessLogs { id, .. }
        | ClientMessage::SendDetectedProcessInput { id, .. }
        | ClientMessage::StopDetectedProcess { id, .. }
        | ClientMessage::RegisterPushToken { id, .. }
        | ClientMessage::AnswerQuestion { id, .. }
        | ClientMessage::GetNotificationHistory { id, .. } => Some(id.clone()),
        ClientMessage::UnsubscribeLogs { .. } => None,
    }
}
