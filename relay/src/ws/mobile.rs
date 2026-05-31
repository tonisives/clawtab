use axum::extract::ws::WebSocket;
use tokio::sync::mpsc;
use uuid::Uuid;

use clawtab_protocol::{
    error_codes, ClientMessage, DesktopMessage, DetectedProcess, ServerMessage,
};

use crate::ws::handler::{run_session_loop, LoopExit};
use crate::ws::hub::MobileConnection;
use crate::ws::shared::get_shared_owner_ids;
use crate::AppState;

pub(super) async fn run(state: AppState, socket: WebSocket, user_id: Uuid) {
    let connection_id = Uuid::new_v4();
    let (tx, rx) = mpsc::unbounded_channel::<String>();

    register(&state, user_id, connection_id, tx.clone()).await;
    send_welcome(&tx, connection_id);
    tracing::info!(%user_id, %connection_id, "mobile connected");

    let exit = drive_session(state.clone(), socket, rx, user_id).await;

    {
        let mut hub = state.hub.write().await;
        hub.remove_mobile(user_id, connection_id);
    }

    log_exit(exit, connection_id);
}

async fn drive_session(
    state: AppState,
    socket: WebSocket,
    rx: mpsc::UnboundedReceiver<String>,
    user_id: Uuid,
) -> LoopExit {
    run_session_loop(socket, rx, move |text| {
        let state = state.clone();
        async move {
            handle_message(&state, user_id, &text).await;
        }
    })
    .await
}

fn log_exit(exit: LoopExit, connection_id: Uuid) {
    if matches!(exit, LoopExit::Timeout) {
        tracing::info!(%connection_id, "mobile timed out");
    } else {
        tracing::info!(%connection_id, "mobile disconnected");
    }
}

async fn register(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    tx: mpsc::UnboundedSender<String>,
) {
    let shared_owners = sqlx::query_as::<_, (Uuid, Option<Vec<String>>)>(
        "SELECT owner_id, allowed_groups FROM workspace_shares WHERE guest_id = $1",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    let mut hub = state.hub.write().await;
    hub.add_mobile(
        user_id,
        MobileConnection {
            connection_id,
            tx: tx.clone(),
        },
    );
    for (owner_id, allowed_groups) in &shared_owners {
        hub.replay_desktop_state_to(*owner_id, &tx);
        let processes = filter_detected_processes_by_groups(
            hub.cached_detected_processes(*owner_id),
            allowed_groups.as_deref(),
        );
        send_desktop_message(
            &tx,
            &DesktopMessage::DetectedProcesses {
                id: "cached_processes".to_string(),
                processes,
            },
        );
    }
}

fn send_desktop_message(tx: &mpsc::UnboundedSender<String>, msg: &DesktopMessage) {
    if let Ok(json) = serde_json::to_string(msg) {
        let _ = tx.send(json);
    }
}

fn send_welcome(tx: &mpsc::UnboundedSender<String>, connection_id: Uuid) {
    if let Ok(json) = serde_json::to_string(&ServerMessage::Welcome {
        connection_id: connection_id.to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
    }) {
        let _ = tx.send(json);
    }
}

async fn handle_message(state: &AppState, user_id: Uuid, text: &str) {
    let Ok(msg) = serde_json::from_str::<ClientMessage>(text) else {
        tracing::warn!(%user_id, "invalid message from mobile: {text}");
        return;
    };

    // Relay-intercepted messages (not forwarded to desktop)
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
        ClientMessage::SetAutoYesPanes { .. } => {
            let hub = state.hub.read().await;
            hub.forward_to_desktop(user_id, &msg);
            return;
        }
        _ => {}
    }

    let target = resolve_target_user(state, user_id).await;

    let Some(target) = target else {
        let preview = &text[..text.len().min(80)];
        tracing::warn!(%user_id, msg_preview = %preview, "no desktop online");
        let error = ServerMessage::Error {
            id: extract_id(&msg),
            code: error_codes::DESKTOP_OFFLINE.into(),
            message: "no desktop app is connected".into(),
        };
        let hub = state.hub.read().await;
        hub.broadcast_to_mobiles(user_id, &error);
        return;
    };

    if let ClientMessage::DetectProcesses { id } = &msg {
        let cached = {
            let hub = state.hub.read().await;
            hub.cached_detected_processes(target)
        };
        let processes = filter_detected_processes_for_mobile(state, user_id, target, cached).await;
        let hub = state.hub.read().await;
        hub.broadcast_to_mobiles(
            user_id,
            &DesktopMessage::DetectedProcesses {
                id: id.clone(),
                processes,
            },
        );
        return;
    }

    let hub = state.hub.read().await;
    if let ClientMessage::AnswerQuestion {
        question_id,
        pane_id,
        answer,
        ..
    } = &msg
    {
        forward_answer(
            &hub,
            &state.pool,
            target,
            &msg,
            question_id,
            pane_id,
            answer,
        );
        return;
    }

    hub.forward_to_desktop(target, &msg);
}

async fn filter_detected_processes_for_mobile(
    state: &AppState,
    user_id: Uuid,
    owner_id: Uuid,
    processes: Vec<DetectedProcess>,
) -> Vec<DetectedProcess> {
    if user_id == owner_id {
        return processes;
    }

    let allowed_groups = sqlx::query_scalar::<_, Option<Vec<String>>>(
        "SELECT allowed_groups FROM workspace_shares WHERE owner_id = $1 AND guest_id = $2 LIMIT 1",
    )
    .bind(owner_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None)
    .flatten();

    let Some(groups) = allowed_groups else {
        return processes;
    };

    filter_detected_processes_by_groups(processes, Some(&groups))
}

fn filter_detected_processes_by_groups(
    processes: Vec<DetectedProcess>,
    allowed_groups: Option<&[String]>,
) -> Vec<DetectedProcess> {
    let Some(groups) = allowed_groups else {
        return processes;
    };

    processes
        .into_iter()
        .filter(|process| {
            process
                .matched_group
                .as_ref()
                .is_some_and(|group| groups.iter().any(|allowed| allowed == group))
        })
        .collect()
}

fn forward_answer(
    hub: &super::Hub,
    pool: &sqlx::PgPool,
    target: Uuid,
    msg: &ClientMessage,
    question_id: &str,
    pane_id: &str,
    answer: &str,
) {
    tracing::info!(%question_id, %pane_id, %answer, %target, "answer via WS");
    let sent = hub.forward_to_desktop(target, msg);
    tracing::info!(%question_id, %answer, sent, "answer via WS forwarded");
    spawn_mark_answered(pool.clone(), question_id.to_string(), answer.to_string());
}

async fn resolve_target_user(state: &AppState, user_id: Uuid) -> Option<Uuid> {
    {
        let hub = state.hub.read().await;
        if hub.has_desktop(user_id) {
            return Some(user_id);
        }
    }
    let owners = get_shared_owner_ids(&state.pool, user_id).await;
    let hub = state.hub.read().await;
    owners.into_iter().find(|&oid| hub.has_desktop(oid))
}

fn spawn_mark_answered(pool: sqlx::PgPool, question_id: String, answer: String) {
    tokio::spawn(async move {
        let res = sqlx::query(
            "UPDATE notification_history SET answered = true, answered_with = $1 WHERE question_id = $2",
        )
        .bind(&answer)
        .bind(&question_id)
        .execute(&pool)
        .await;
        if let Err(e) = res {
            tracing::warn!(%question_id, "failed to mark answered: {e}");
        }
    });
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
        tracing::error!(%user_id, "failed to save push token: {e}");
    }

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

async fn handle_get_notification_history(state: &AppState, user_id: Uuid, id: &str, limit: u32) {
    let limit = limit.min(50) as i64;
    type Row = (
        String,
        String,
        String,
        String,
        serde_json::Value,
        bool,
        Option<String>,
        chrono::DateTime<chrono::Utc>,
    );
    let rows: Vec<Row> = sqlx::query_as(
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
        .map(
            |(
                question_id,
                pane_id,
                cwd,
                context_lines,
                options,
                answered,
                answered_with,
                created_at,
            )| {
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
            },
        )
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
        | ClientMessage::GetSettings { id, .. }
        | ClientMessage::GetRunDetail { id, .. }
        | ClientMessage::GetDetectedProcessLogs { id, .. }
        | ClientMessage::SendDetectedProcessInput { id, .. }
        | ClientMessage::StopDetectedProcess { id, .. }
        | ClientMessage::RegisterPushToken { id, .. }
        | ClientMessage::AnswerQuestion { id, .. }
        | ClientMessage::SetAutoYesPanes { id, .. }
        | ClientMessage::GetNotificationHistory { id, .. }
        | ClientMessage::SubscribePty { id, .. } => Some(id.clone()),
        ClientMessage::UnsubscribeLogs { .. }
        | ClientMessage::UnsubscribePty { .. }
        | ClientMessage::PtyInput { .. }
        | ClientMessage::TmuxPaneKey { .. }
        | ClientMessage::PtyResize { .. } => None,
    }
}
