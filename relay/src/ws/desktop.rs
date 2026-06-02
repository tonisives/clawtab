use std::collections::{HashMap, HashSet};

use axum::extract::ws::WebSocket;
use tokio::sync::mpsc;
use uuid::Uuid;

use clawtab_protocol::{DesktopMessage, JobStatus, RemoteJob, ServerMessage};

use crate::ws::handler::{run_session_loop, LoopExit};
use crate::ws::hub::DesktopConnection;
use crate::ws::push::{
    handle_claude_questions_push, handle_job_notification_push, handle_trigger_result,
};
use crate::ws::shared::{filter_questions_for_groups, get_shared_guests, SharedGuest};
use crate::AppState;

pub(super) async fn run(
    state: AppState,
    socket: WebSocket,
    user_id: Uuid,
    device_id: Uuid,
    device_name: String,
) {
    let (tx, rx) = mpsc::unbounded_channel::<String>();

    let guests = get_shared_guests(&state.pool, user_id).await;
    let guest_ids: Vec<Uuid> = guests.iter().map(|g| g.guest_id).collect();

    register(
        &state,
        user_id,
        device_id,
        &device_name,
        tx.clone(),
        &guest_ids,
    )
    .await;
    send_welcome(&tx, device_id);
    tracing::info!(%user_id, %device_id, %device_name, "desktop connected");

    let exit = drive_session(state.clone(), socket, rx, user_id).await;

    unregister(&state, user_id, device_id, &device_name, &guest_ids).await;
    update_device_last_seen(&state.pool, device_id).await;
    log_exit(exit, device_id);
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

async fn update_device_last_seen(pool: &sqlx::PgPool, device_id: Uuid) {
    sqlx::query("UPDATE devices SET last_seen = now() WHERE id = $1")
        .bind(device_id)
        .execute(pool)
        .await
        .ok();
}

fn log_exit(exit: LoopExit, device_id: Uuid) {
    if matches!(exit, LoopExit::Timeout) {
        tracing::info!(%device_id, "desktop timed out");
    } else {
        tracing::info!(%device_id, "desktop disconnected");
    }
}

async fn register(
    state: &AppState,
    user_id: Uuid,
    device_id: Uuid,
    device_name: &str,
    tx: mpsc::UnboundedSender<String>,
    guest_ids: &[Uuid],
) {
    let mut hub = state.hub.write().await;
    hub.add_desktop(
        user_id,
        DesktopConnection {
            device_id,
            device_name: device_name.to_string(),
            tx,
        },
    );
    for &gid in guest_ids {
        hub.broadcast_to_mobiles(
            gid,
            &ServerMessage::DesktopStatus {
                device_id: device_id.to_string(),
                device_name: device_name.to_string(),
                online: true,
            },
        );
    }
}

async fn unregister(
    state: &AppState,
    user_id: Uuid,
    device_id: Uuid,
    device_name: &str,
    guest_ids: &[Uuid],
) {
    let mut hub = state.hub.write().await;
    hub.remove_desktop(user_id, device_id);
    for &gid in guest_ids {
        hub.broadcast_to_mobiles(
            gid,
            &ServerMessage::DesktopStatus {
                device_id: device_id.to_string(),
                device_name: device_name.to_string(),
                online: false,
            },
        );
    }
}

fn send_welcome(tx: &mpsc::UnboundedSender<String>, device_id: Uuid) {
    if let Ok(json) = serde_json::to_string(&ServerMessage::Welcome {
        connection_id: device_id.to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
    }) {
        let _ = tx.send(json);
    }
}

async fn handle_message(state: &AppState, user_id: Uuid, text: &str) {
    let Ok(msg) = serde_json::from_str::<DesktopMessage>(text) else {
        tracing::warn!(%user_id, "invalid message from desktop: {text}");
        return;
    };

    let guests = get_shared_guests(&state.pool, user_id).await;

    match &msg {
        DesktopMessage::ClaudeQuestions {
            questions,
            apns_questions,
        } => {
            tracing::info!(
                %user_id,
                questions = questions.len(),
                apns_questions = apns_questions.as_ref().map_or(questions.len(), Vec::len),
                "claude questions from desktop"
            );
            fanout_claude_questions(state, user_id, questions, text, &guests).await;
            let push_questions = apns_questions.as_ref().unwrap_or(questions);
            if !push_questions.is_empty() {
                spawn_push(state.clone(), user_id, push_questions.clone());
            }
        }
        DesktopMessage::AutoYesPanes { pane_ids } => {
            fanout_auto_yes_panes(state, user_id, pane_ids, text, &guests).await;
        }
        DesktopMessage::JobsList { jobs, statuses, id } => {
            let hub = state.hub.read().await;
            hub.send_raw_to_mobiles(user_id, text);
            for guest in &guests {
                let Some((filtered_jobs, filtered_statuses)) =
                    filter_jobs_by_group(guest, jobs, statuses)
                else {
                    hub.send_raw_to_mobiles(guest.guest_id, text);
                    continue;
                };
                hub.broadcast_to_mobiles(
                    guest.guest_id,
                    &DesktopMessage::JobsList {
                        id: id.clone(),
                        jobs: filtered_jobs,
                        statuses: filtered_statuses,
                    },
                );
            }
        }
        DesktopMessage::JobsChanged { jobs, statuses } => {
            let hub = state.hub.read().await;
            hub.send_raw_to_mobiles(user_id, text);
            for guest in &guests {
                let Some((filtered_jobs, filtered_statuses)) =
                    filter_jobs_by_group(guest, jobs, statuses)
                else {
                    hub.send_raw_to_mobiles(guest.guest_id, text);
                    continue;
                };
                hub.broadcast_to_mobiles(
                    guest.guest_id,
                    &DesktopMessage::JobsChanged {
                        jobs: filtered_jobs,
                        statuses: filtered_statuses,
                    },
                );
            }
        }
        DesktopMessage::DetectedProcesses { id, processes } => {
            let mut hub = state.hub.write().await;
            hub.set_cached_detected_processes(user_id, processes.clone());
            hub.send_raw_to_mobiles(user_id, text);
            for guest in &guests {
                forward_detected_processes(&hub, guest, text, id, processes);
            }
        }
        DesktopMessage::TriggerResult {
            trigger_id,
            status,
            exit_code,
            result,
            error,
        } => {
            // Internal-only channel for the triggers service. Do NOT fan out to mobiles.
            handle_trigger_result(
                state, user_id, trigger_id, status, *exit_code, result, error,
            )
            .await;
        }
        _ => {
            let hub = state.hub.read().await;
            hub.send_raw_to_mobiles(user_id, text);
            for guest in &guests {
                hub.send_raw_to_mobiles(guest.guest_id, text);
            }
        }
    }

    if let DesktopMessage::JobNotification {
        name,
        event,
        run_id,
    } = &msg
    {
        spawn_job_notification(
            state.clone(),
            user_id,
            name.clone(),
            event.clone(),
            run_id.clone(),
        );
    }
}

async fn fanout_claude_questions(
    state: &AppState,
    user_id: Uuid,
    questions: &[clawtab_protocol::ClaudeQuestion],
    raw_text: &str,
    guests: &[SharedGuest],
) {
    let mut hub = state.hub.write().await;
    hub.set_cached_questions(user_id, questions.to_vec());
    hub.send_raw_to_mobiles(user_id, raw_text);
    for guest in guests {
        match filter_questions_for_groups(questions, guest.allowed_groups.as_deref()) {
            None => hub.send_raw_to_mobiles(guest.guest_id, raw_text),
            Some(filtered) => {
                hub.broadcast_to_mobiles(
                    guest.guest_id,
                    &DesktopMessage::ClaudeQuestions {
                        questions: filtered,
                        apns_questions: None,
                    },
                );
            }
        }
    }
}

async fn fanout_auto_yes_panes(
    state: &AppState,
    user_id: Uuid,
    pane_ids: &[String],
    raw_text: &str,
    guests: &[SharedGuest],
) {
    let pane_set: HashSet<String> = pane_ids.iter().cloned().collect();
    let mut hub = state.hub.write().await;
    hub.set_auto_yes_panes(user_id, pane_set);
    hub.set_cached_auto_yes_panes_json(user_id, raw_text);
    hub.send_raw_to_mobiles(user_id, raw_text);
    for guest in guests {
        hub.send_raw_to_mobiles(guest.guest_id, raw_text);
    }
}

/// Returns `None` when no group filter is configured (caller should forward raw).
/// Returns `Some((jobs, statuses))` with the filtered view otherwise.
fn filter_jobs_by_group(
    guest: &SharedGuest,
    jobs: &[RemoteJob],
    statuses: &HashMap<String, JobStatus>,
) -> Option<(Vec<RemoteJob>, HashMap<String, JobStatus>)> {
    let groups = guest.allowed_groups.as_deref()?;
    let filtered_jobs: Vec<RemoteJob> = jobs
        .iter()
        .filter(|j| groups.contains(&j.group))
        .cloned()
        .collect();
    let filtered_statuses: HashMap<String, JobStatus> = filtered_jobs
        .iter()
        .filter_map(|j| statuses.get(&j.name).map(|s| (j.name.clone(), s.clone())))
        .collect();
    Some((filtered_jobs, filtered_statuses))
}

fn forward_detected_processes(
    hub: &super::Hub,
    guest: &SharedGuest,
    raw_text: &str,
    id: &str,
    processes: &[clawtab_protocol::DetectedProcess],
) {
    let Some(ref groups) = guest.allowed_groups else {
        hub.send_raw_to_mobiles(guest.guest_id, raw_text);
        return;
    };
    let filtered: Vec<_> = processes
        .iter()
        .filter(|p| p.matched_group.as_ref().is_some_and(|g| groups.contains(g)))
        .cloned()
        .collect();
    hub.broadcast_to_mobiles(
        guest.guest_id,
        &DesktopMessage::DetectedProcesses {
            id: id.to_string(),
            processes: filtered,
        },
    );
}

fn spawn_push(state: AppState, user_id: Uuid, questions: Vec<clawtab_protocol::ClaudeQuestion>) {
    tokio::spawn(async move {
        handle_claude_questions_push(&state, user_id, &questions).await;
    });
}

fn spawn_job_notification(
    state: AppState,
    user_id: Uuid,
    name: String,
    event: String,
    run_id: String,
) {
    tokio::spawn(async move {
        handle_job_notification_push(&state, user_id, &name, &event, &run_id).await;
    });
}
