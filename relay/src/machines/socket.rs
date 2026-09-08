use super::router::{filtered, Client, Lease, Pending};
use crate::{error::AppError, AppState};
use axum::extract::{ws::WebSocket, Query, State, WebSocketUpgrade};
use axum::response::Response;
use clawtab_protocol::{ClientMessage, HostCommand, MachineCommand};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct Auth {
    token: String,
    channel: Option<String>,
}
pub async fn connect(
    State(state): State<AppState>,
    Query(auth): Query<Auth>,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    let claims = crate::auth::validate_access_token(&auth.token, &state.config.jwt_secret)?;
    if !crate::billing::is_subscribed(&state.pool, &state.config, claims.sub).await? {
        return Err(AppError::Forbidden);
    }
    Ok(ws
        .max_message_size(2 * 1024 * 1024)
        .on_upgrade(move |socket| {
            run(
                state,
                socket,
                claims.sub,
                auth.channel.as_deref() == Some("transfer"),
            )
        }))
}
async fn run(state: AppState, socket: WebSocket, user: Uuid, transfers_only: bool) {
    let client = Uuid::new_v4();
    let (tx, rx) = mpsc::channel(512);
    let cancel = std::sync::Arc::new(tokio::sync::Notify::new());
    {
        let mut hub = state.machines.write().await;
        if hub.clients.values().filter(|c| c.user == user).count()
            >= state.config.max_connections_per_user
        {
            return;
        }
        hub.clients.insert(
            client,
            Client {
                user,
                tx,
                transfers_only,
                cancel: cancel.clone(),
            },
        );
    }
    refresh(&state, user, client, !transfers_only).await;
    let state_for_loop = state.clone();
    let session = crate::ws::handler::run_session_loop(socket, rx, move |text| {
        let state = state_for_loop.clone();
        async move {
            let request = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v["request_id"].as_str().map(str::to_owned));
            if let Err(error) = handle(&state, user, client, &text).await {
                state.machines.read().await.send(client,&json!({"type":"machine_error","request_id":request,"message":error.to_string()}));
            }
        }
    });
    tokio::select! {_=session=>{},_=cancel.notified()=>{}}
    state.machines.write().await.remove_client(client);
}
async fn refresh(state: &AppState, user: Uuid, client: Uuid, replay: bool) {
    let Ok(machines) = super::api::list_for(state, user).await else {
        return;
    };
    state.machines.read().await.send(
        client,
        &json!({"type":"machines","version":2,"connection_id":client,"machines":machines}),
    );
    if !replay {
        return;
    }
    let snapshots = state.machines.read().await.snapshots.clone();
    for ((machine, _), payload) in snapshots {
        let Ok(grant) = super::access(state, user, machine).await else {
            continue;
        };
        let payload = filtered(&payload, grant.as_ref().and_then(|g| g.as_deref()));
        if let Some(payload) = payload {
            state.machines.read().await.send(
                client,
                &json!({"type":"machine_event","version":2,"machine_id":machine,"message":payload}),
            );
        }
    }
}
async fn handle(state: &AppState, user: Uuid, client: Uuid, text: &str) -> Result<(), AppError> {
    let value: Value =
        serde_json::from_str(text).map_err(|_| AppError::BadRequest("invalid JSON".into()))?;
    if value["type"] == "refresh_machines" {
        refresh(state, user, client, false).await;
        return Ok(());
    }
    let command: MachineCommand = serde_json::from_value(value)
        .map_err(|_| AppError::BadRequest("machine command required".into()))?;
    if command.version != 2 {
        return Err(AppError::BadRequest("unsupported protocol version".into()));
    }
    if command.request_id.len() > 128 {
        return Err(AppError::BadRequest("request ID too long".into()));
    }
    let machine = Uuid::parse_str(&command.machine_id)
        .map_err(|_| AppError::BadRequest("invalid machine ID".into()))?;
    let grant = super::access(state, user, machine).await?;
    let mut message = command.message;
    let kind = message["type"].as_str().unwrap_or_default().to_owned();
    let transfer = kind == "host_request"
        && message["request"]["action"]
            .as_str()
            .is_some_and(|action| action.starts_with("transfer_"));
    if state
        .machines
        .read()
        .await
        .clients
        .get(&client)
        .is_some_and(|c| c.transfers_only)
        && !transfer
    {
        return Err(AppError::Forbidden);
    }

    // Job input must obey the same pane lease as direct terminal input.
    if kind == "send_input" {
        let hub = state.machines.read().await;
        let pane = hub
            .snapshots
            .get(&(machine, "jobs_changed".into()))
            .and_then(|v| v["statuses"].get(message["name"].as_str().unwrap_or_default()))
            .and_then(|s| s["pane_id"].as_str())
            .ok_or_else(|| AppError::Conflict("job has no active terminal".into()))?;
        if !hub.controls(machine, pane, client) {
            return Err(AppError::Conflict(
                "take control before sending terminal input".into(),
            ));
        }
    }
    let pane = message["pane_id"].as_str().map(str::to_owned);
    if grant.is_some() {
        authorize_guest(state, machine, &message, grant.flatten().as_deref()).await?;
    }
    let mut hub = state.machines.write().await;
    if !hub.online(machine) {
        return Err(AppError::Conflict("machine is offline".into()));
    }
    if let Some(ref pane) = pane {
        let process = hub
            .snapshots
            .get(&(machine, "detected_processes".into()))
            .and_then(|s| s["processes"].as_array())
            .and_then(|ps| ps.iter().find(|p| p["pane_id"] == *pane));
        let expected = process.and_then(|p| p["execution_id"].as_str());
        if !matches!(kind.as_str(), "unsubscribe_pty" | "release_control")
            && expected.is_some()
            && message["execution_id"].as_str() != expected
        {
            return Err(AppError::Conflict(
                "execution changed; refresh the session".into(),
            ));
        }
        let key = (machine, pane.clone());
        if matches!(
            kind.as_str(),
            "take_control" | "renew_control" | "release_control"
        ) {
            match kind.as_str() {
                "take_control" => {
                    hub.controllers.insert(
                        key.clone(),
                        Lease {
                            client,
                            renewed: Instant::now(),
                            cols: message["cols"].as_u64().unwrap_or(80).clamp(1, 500) as u32,
                            rows: message["rows"].as_u64().unwrap_or(24).clamp(1, 300) as u32,
                        },
                    );
                }
                "renew_control" if hub.controls(machine, pane, client) => {
                    if let Some(lease) = hub.controllers.get_mut(&key) {
                        lease.renewed = Instant::now();
                    }
                }
                "release_control" => {
                    if hub.controls(machine, pane, client) {
                        hub.controllers.remove(&key);
                    }
                }
                _ => {
                    return Err(AppError::Conflict(
                        "terminal is controlled by another client".into(),
                    ))
                }
            }
            let controller = hub.controllers.get(&key).map(|l| l.client);
            hub.send(client,&json!({"type":"terminal_control","machine_id":machine,"pane_id":pane,"controller":controller}));
            for recipient in hub.viewers.get(&key).into_iter().flatten() {
                hub.send(*recipient,&json!({"type":"terminal_control","machine_id":machine,"pane_id":pane,"controller":controller}));
            }
            hub.send(client,&json!({"type":"machine_event","machine_id":machine,"request_id":command.request_id,"message":{"type":"control_ack","controller":controller}}));
            return Ok(());
        }
        if kind == "subscribe_pty" {
            hub.viewers.entry(key.clone()).or_default().insert(client);
            if !hub
                .controllers
                .get(&key)
                .is_some_and(|l| l.renewed.elapsed() < Duration::from_secs(30))
            {
                hub.controllers.insert(
                    key.clone(),
                    Lease {
                        client,
                        renewed: Instant::now(),
                        cols: message["cols"].as_u64().unwrap_or(80).clamp(1, 500) as u32,
                        rows: message["rows"].as_u64().unwrap_or(24).clamp(1, 300) as u32,
                    },
                );
            }
            let controller = hub.controllers.get(&key).map(|l| l.client);
            hub.send(client,&json!({"type":"terminal_control","machine_id":machine,"pane_id":pane,"controller":controller}));
            if !hub.controls(machine, pane, client) {
                // Existing observers reuse the controller's dimensions; never resize it.
                if let Some(lease) = hub.controllers.get(&key) {
                    message["cols"] = json!(lease.cols);
                    message["rows"] = json!(lease.rows);
                }
            }
        }
        if kind == "pty_resize" && hub.controls(machine, pane, client) {
            if let Some(lease) = hub.controllers.get_mut(&key) {
                lease.cols = message["cols"].as_u64().unwrap_or(80).clamp(1, 500) as u32;
                lease.rows = message["rows"].as_u64().unwrap_or(24).clamp(1, 300) as u32;
            }
        }
        if kind == "unsubscribe_pty" {
            if let Some(viewers) = hub.viewers.get_mut(&key) {
                viewers.remove(&client);
                if !viewers.is_empty() {
                    hub.send(client,&json!({"type":"machine_event","machine_id":machine,"request_id":command.request_id,"message":{"type":"sent"}}));
                    return Ok(());
                }
            }
            hub.viewers.remove(&key);
        }
        if matches!(
            kind.as_str(),
            "pty_input"
                | "pty_resize"
                | "tmux_pane_key"
                | "send_detected_process_input"
                | "start_agent_action"
        ) && !hub.controls(machine, pane, client)
        {
            return Err(AppError::Conflict(
                "take control before sending terminal input".into(),
            ));
        }
    }
    if kind == "host_request" {
        serde_json::from_value::<HostCommand>(message.clone())
            .map_err(|_| AppError::BadRequest("invalid host request".into()))?;
    } else {
        serde_json::from_value::<ClientMessage>(message.clone())
            .map_err(|_| AppError::BadRequest("unsupported command".into()))?;
    }
    hub.pending
        .retain(|_, p| p.since.elapsed() < Duration::from_secs(120));
    if hub.pending.values().filter(|p| p.client == client).count() >= 128 {
        return Err(AppError::RateLimited);
    }
    if hub
        .hosts
        .get(&machine)
        .is_none_or(|host| host.tx.capacity() == 0)
    {
        return Err(AppError::RateLimited);
    }
    if kind == "answer_question" {
        let key = (
            machine,
            message["pane_id"].as_str().unwrap_or_default().to_owned(),
            message["question_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        );
        let active = hub
            .snapshots
            .get(&(machine, "claude_questions".into()))
            .and_then(|s| s["questions"].as_array())
            .is_some_and(|qs| {
                qs.iter().any(|q| {
                    q["question_id"] == message["question_id"] && q["pane_id"] == message["pane_id"]
                })
            });
        if !active || hub.answered.contains(&key) {
            return Err(AppError::Conflict("question already resolved".into()));
        }
        hub.answered.insert(key);
    }
    let id = format!("v2:{}", Uuid::new_v4());
    message["id"] = json!(id);
    let no_ack = matches!(
        kind.as_str(),
        "pty_input"
            | "pty_resize"
            | "unsubscribe_pty"
            | "unsubscribe_logs"
            | "set_auto_yes_panes"
            | "tmux_pane_key"
    );
    if no_ack {
        hub.send(client,&json!({"type":"machine_event","machine_id":machine,"request_id":command.request_id,"message":{"type":"sent"}}));
    } else {
        hub.pending.insert(
            id,
            Pending {
                resource: message.clone(),
                client,
                request: command.request_id,
                machine,
                since: Instant::now(),
            },
        );
    }
    let Some(host) = hub.hosts.get(&machine) else {
        return Err(AppError::Conflict("machine disconnected".into()));
    };
    if host.tx.capacity() == 0 {
        return Err(AppError::RateLimited);
    }
    host.tx
        .try_send(message.to_string())
        .map_err(|_| AppError::Conflict("machine disconnected".into()))?;
    Ok(())
}
async fn authorize_guest(
    state: &AppState,
    machine: Uuid,
    message: &Value,
    groups: Option<&[String]>,
) -> Result<(), AppError> {
    let kind = message["type"].as_str().unwrap_or_default();
    if matches!(kind, "list_jobs" | "detect_processes") {
        return Ok(());
    }
    let pane_command = matches!(
        kind,
        "subscribe_pty"
            | "unsubscribe_pty"
            | "pty_input"
            | "pty_resize"
            | "tmux_pane_key"
            | "get_detected_process_logs"
            | "send_detected_process_input"
            | "stop_detected_process"
            | "answer_question"
            | "list_agent_actions"
            | "start_agent_action"
            | "take_control"
            | "renew_control"
            | "release_control"
    );
    let job_command = matches!(
        kind,
        "run_job"
            | "pause_job"
            | "resume_job"
            | "stop_job"
            | "send_input"
            | "subscribe_logs"
            | "unsubscribe_logs"
            | "get_run_history"
    );
    let run_command = matches!(
        kind,
        "get_run_detail" | "get_agent_action_run" | "cancel_agent_action"
    );
    if !pane_command && !job_command && !run_command {
        return Err(AppError::Forbidden);
    }
    let hub = state.machines.read().await;
    let resource = if run_command {
        hub.run_resources
            .get(&(
                machine,
                message["run_id"].as_str().unwrap_or_default().into(),
            ))
            .ok_or(AppError::Forbidden)?
    } else {
        message
    };
    if let Some(pane) = resource["pane_id"]
        .as_str()
        .filter(|_| pane_command || run_command)
    {
        let visible = hub
            .snapshots
            .get(&(machine, "detected_processes".into()))
            .and_then(|v| v["processes"].as_array())
            .is_some_and(|ps| {
                ps.iter().any(|p| {
                    p["pane_id"] == pane
                        && groups.is_none_or(|gs| {
                            p["matched_group"]
                                .as_str()
                                .is_some_and(|g| gs.iter().any(|allowed| allowed == g))
                        })
                })
            });
        if visible {
            return Ok(());
        }
    }
    if let Some(name) = resource["name"]
        .as_str()
        .filter(|_| job_command || run_command)
    {
        let visible = hub
            .snapshots
            .get(&(machine, "jobs_changed".into()))
            .and_then(|v| v["jobs"].as_array())
            .is_some_and(|js| {
                js.iter().any(|j| {
                    (j["name"] == name || j["slug"] == name)
                        && groups.is_none_or(|gs| {
                            j["group"]
                                .as_str()
                                .is_some_and(|g| gs.iter().any(|allowed| allowed == g))
                        })
                })
            });
        if visible {
            return Ok(());
        }
    }
    Err(AppError::Forbidden)
}
