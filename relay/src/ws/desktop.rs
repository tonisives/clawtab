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
    let connection_id = Uuid::new_v4();
    let (tx, rx) = mpsc::channel::<String>(512);

    let guests = get_shared_guests(&state.pool, user_id, device_id).await;
    let guest_ids: Vec<Uuid> = guests.iter().map(|g| g.guest_id).collect();

    register(
        &state,
        user_id,
        connection_id,
        device_id,
        &device_name,
        tx.clone(),
        &guest_ids,
    )
    .await;
    send_welcome(&tx, device_id);
    tracing::info!(%user_id, %device_id, %connection_id, %device_name, "desktop connected");

    state.machines.write().await.register(
        device_id,
        crate::machines::Host {
            connection: connection_id,
            owner: user_id,
            tx: tx.clone(),
        },
    );
    let _ = tx.try_send(
        serde_json::json!({"type":"host_request","id":"machine_info","request":{"action":"info"}})
            .to_string(),
    );
    let exit = drive_session(state.clone(), socket, rx, user_id, device_id, connection_id).await;
    state
        .machines
        .write()
        .await
        .unregister(device_id, connection_id);

    unregister(
        &state,
        user_id,
        connection_id,
        device_id,
        &device_name,
        &guest_ids,
    )
    .await;
    update_device_last_seen(&state.pool, device_id).await;
    log_exit(exit, device_id);
}

async fn drive_session(
    state: AppState,
    socket: WebSocket,
    rx: mpsc::Receiver<String>,
    user_id: Uuid,
    device_id: Uuid,
    connection_id: Uuid,
) -> LoopExit {
    run_session_loop(socket, rx, move |text| {
        let state = state.clone();
        async move {
            if !state
                .machines
                .read()
                .await
                .hosts
                .get(&device_id)
                .is_some_and(|h| h.connection == connection_id)
            {
                return;
            }
            crate::machines::host_event(&state, device_id, connection_id, &text).await;
            handle_message(&state, user_id, device_id, &text).await;
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
    connection_id: Uuid,
    device_id: Uuid,
    device_name: &str,
    tx: mpsc::Sender<String>,
    guest_ids: &[Uuid],
) {
    let mut hub = state.hub.write().await;
    hub.add_desktop(
        user_id,
        DesktopConnection {
            connection_id,
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
    connection_id: Uuid,
    device_id: Uuid,
    device_name: &str,
    guest_ids: &[Uuid],
) {
    let mut hub = state.hub.write().await;
    if hub.remove_desktop(user_id, connection_id) {
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
}

fn send_welcome(tx: &mpsc::Sender<String>, device_id: Uuid) {
    if let Ok(json) = serde_json::to_string(&ServerMessage::Welcome {
        connection_id: device_id.to_string(),
        server_version: env!("CARGO_PKG_VERSION").to_string(),
    }) {
        let _ = tx.try_send(json);
    }
}

async fn handle_message(state: &AppState, user_id: Uuid, device_id: Uuid, text: &str) {
    let Ok(msg) = serde_json::from_str::<DesktopMessage>(text) else {
        tracing::debug!(%user_id, "ignoring non-legacy desktop message");
        return;
    };

    let guests = get_shared_guests(&state.pool, user_id, device_id).await;

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
                spawn_push(state.clone(), user_id, device_id, push_questions.clone());
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
        DesktopMessage::AgentActivity { activity } => {
            let mut hub = state.hub.write().await;
            hub.set_cached_agent_activity(user_id, activity.clone());
            hub.send_raw_to_mobiles(user_id, text);
            for guest in &guests {
                let Some(groups) = guest.allowed_groups.as_deref() else {
                    hub.send_raw_to_mobiles(guest.guest_id, text);
                    continue;
                };
                let activity = hub.cached_agent_activity(user_id, Some(groups));
                hub.broadcast_to_mobiles(
                    guest.guest_id,
                    &DesktopMessage::AgentActivity { activity },
                );
            }
        }
        DesktopMessage::AgentActions { pane_id, .. } => {
            let hub = state.hub.read().await;
            forward_agent_message(&hub, user_id, text, &guests, pane_id);
        }
        DesktopMessage::AgentActionStarted { run: Some(run), .. }
        | DesktopMessage::AgentActionRun { run: Some(run), .. }
        | DesktopMessage::AgentActionProgress { run } => {
            let hub = state.hub.read().await;
            forward_agent_message(&hub, user_id, text, &guests, &run.pane_id);
        }
        DesktopMessage::AgentActionStarted { run: None, .. }
        | DesktopMessage::AgentActionRun { run: None, .. } => {
            let hub = state.hub.read().await;
            hub.send_raw_to_mobiles(user_id, text);
            for guest in &guests {
                hub.send_raw_to_mobiles(guest.guest_id, text);
            }
        }
        DesktopMessage::PinnedItems { items } => {
            let mut hub = state.hub.write().await;
            hub.set_cached_pinned_items(user_id, items.clone());
            hub.send_raw_to_mobiles(user_id, text);
        }
        DesktopMessage::PaneDisplayNameChanged { .. } => {
            // Owners can rename panes. Guests receive the new name through the
            // next filtered process snapshot, never through an unfiltered event.
            let hub = state.hub.read().await;
            hub.send_raw_to_mobiles(user_id, text);
        }
        DesktopMessage::UsageResponse { .. } => {
            // Provider quota data belongs to the workspace owner and is not
            // part of the shared workspace view.
            let hub = state.hub.read().await;
            hub.send_raw_to_mobiles(user_id, text);
        }
        DesktopMessage::TriggerResult { .. } => {
            // Internal-only channel for the triggers service. Do NOT fan out to mobiles.
            handle_trigger_result(state, user_id, device_id, &msg).await;
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
            device_id,
            name.clone(),
            event.clone(),
            run_id.clone(),
        );
    }
}

fn forward_agent_message(
    hub: &super::Hub,
    owner_id: Uuid,
    text: &str,
    guests: &[SharedGuest],
    pane_id: &str,
) {
    hub.send_raw_to_mobiles(owner_id, text);
    let processes = hub.cached_detected_processes(owner_id);
    for guest in guests {
        let allowed = guest.allowed_groups.as_deref().is_none_or(|groups| {
            processes.iter().any(|process| {
                process.pane_id == pane_id
                    && process.matched_group.as_ref().is_some_and(|group| {
                        groups.iter().any(|allowed_group| allowed_group == group)
                    })
            })
        });
        if allowed {
            hub.send_raw_to_mobiles(guest.guest_id, text);
        }
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

fn spawn_push(
    state: AppState,
    user_id: Uuid,
    device_id: Uuid,
    questions: Vec<clawtab_protocol::ClaudeQuestion>,
) {
    tokio::spawn(async move {
        let auto_yes = state
            .machines
            .read()
            .await
            .snapshots
            .get(&(device_id, "auto_yes_panes".into()))
            .and_then(|v| v["pane_ids"].as_array())
            .cloned()
            .unwrap_or_default();
        let questions = questions
            .into_iter()
            .filter(|q| !auto_yes.iter().any(|p| p.as_str() == Some(&q.pane_id)))
            .map(|mut q| {
                q.pane_id = format!("{device_id}::{}", q.pane_id);
                q.question_id = format!("{device_id}::{}", q.question_id);
                q.matched_job = q.matched_job.map(|name| format!("{device_id}::{name}"));
                q
            })
            .collect::<Vec<_>>();
        handle_claude_questions_push(&state, user_id, &questions).await;
    });
}

fn spawn_job_notification(
    state: AppState,
    user_id: Uuid,
    device_id: Uuid,
    name: String,
    event: String,
    run_id: String,
) {
    tokio::spawn(async move {
        handle_job_notification_push(
            &state,
            user_id,
            &format!("{device_id}::{name}"),
            &event,
            &format!("{device_id}::{run_id}"),
        )
        .await;
    });
}
