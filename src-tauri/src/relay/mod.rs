mod handler;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use clawtab_protocol::{DesktopMessage, JobStatus as RemoteJobStatus, RemoteJob};

use crate::config::jobs::{Job, JobStatus, JobsConfig};
use crate::config::settings::AppSettings;
use crate::history::HistoryStore;
use crate::secrets::SecretsManager;
use crate::telegram::ActiveAgent;

/// Relay connection state, shared via Arc<Mutex<..>> in AppState.
pub struct RelayHandle {
    tx: mpsc::UnboundedSender<String>,
    cancel: tokio_util::sync::CancellationToken,
}

impl RelayHandle {
    /// Send a protocol message to the relay server.
    pub fn send_message(&self, msg: &DesktopMessage) {
        if let Ok(json) = serde_json::to_string(msg) {
            let _ = self.tx.send(json);
        }
    }

    /// Disconnect from the relay server.
    pub fn disconnect(&self) {
        self.cancel.cancel();
    }
}

/// Push the full job list + statuses to relay. Called on connect and on job config change.
pub fn push_full_state(
    handle: &RelayHandle,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) {
    let jobs = jobs_config.lock().unwrap().jobs.clone();
    let statuses = job_status.lock().unwrap().clone();

    let remote_jobs: Vec<RemoteJob> = jobs.iter().map(job_to_remote).collect();
    let remote_statuses: HashMap<String, RemoteJobStatus> = statuses
        .into_iter()
        .map(|(k, v)| (k, status_to_remote(&v)))
        .collect();

    handle.send_message(&DesktopMessage::JobsChanged {
        jobs: remote_jobs,
        statuses: remote_statuses,
    });
}

/// Push full state to relay if connected. Convenience wrapper for job config changes.
pub fn push_full_state_if_connected(
    relay: &Arc<Mutex<Option<RelayHandle>>>,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
) {
    if let Ok(guard) = relay.lock() {
        if let Some(handle) = guard.as_ref() {
            push_full_state(handle, jobs_config, job_status);
        }
    }
}

/// Notify relay of a single job status change.
pub fn push_status_update(
    relay: &Arc<Mutex<Option<RelayHandle>>>,
    job_name: &str,
    status: &JobStatus,
) {
    if let Ok(guard) = relay.lock() {
        if let Some(handle) = guard.as_ref() {
            handle.send_message(&DesktopMessage::StatusUpdate {
                name: job_name.to_string(),
                status: status_to_remote(status),
            });
        }
    }
}

/// Push a log chunk to relay for a specific job.
pub fn push_log_chunk(relay: &Arc<Mutex<Option<RelayHandle>>>, job_name: &str, content: &str) {
    if content.is_empty() {
        return;
    }
    if let Ok(guard) = relay.lock() {
        if let Some(handle) = guard.as_ref() {
            handle.send_message(&DesktopMessage::LogChunk {
                name: job_name.to_string(),
                content: content.to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
            });
        }
    }
}

/// Start the relay connection loop. Runs forever with reconnection.
pub async fn connect_loop(
    server_url: String,
    device_token: String,
    relay: Arc<Mutex<Option<RelayHandle>>>,
    jobs_config: Arc<Mutex<JobsConfig>>,
    job_status: Arc<Mutex<HashMap<String, JobStatus>>>,
    secrets: Arc<Mutex<SecretsManager>>,
    history: Arc<Mutex<HistoryStore>>,
    settings: Arc<Mutex<AppSettings>>,
    active_agents: Arc<Mutex<HashMap<i64, ActiveAgent>>>,
) {
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(60);

    loop {
        log::info!("Relay: connecting to {}", server_url);

        let ws_url = format!("{}?device_token={}", server_url, device_token);
        match tokio_tungstenite::connect_async(&ws_url).await {
            Ok((ws_stream, _)) => {
                log::info!("Relay: connected");
                backoff = Duration::from_secs(1);

                let (ws_sink, ws_stream) = ws_stream.split();
                let (tx, rx) = mpsc::unbounded_channel::<String>();
                let cancel = tokio_util::sync::CancellationToken::new();

                let handle = RelayHandle {
                    tx: tx.clone(),
                    cancel: cancel.clone(),
                };

                push_full_state(&handle, &jobs_config, &job_status);

                {
                    let mut guard = relay.lock().unwrap();
                    *guard = Some(handle);
                }

                run_session(
                    ws_sink,
                    ws_stream,
                    rx,
                    tx,
                    cancel.clone(),
                    &relay,
                    &jobs_config,
                    &job_status,
                    &secrets,
                    &history,
                    &settings,
                    &active_agents,
                )
                .await;

                {
                    let mut guard = relay.lock().unwrap();
                    *guard = None;
                }

                if cancel.is_cancelled() {
                    log::info!("Relay: disconnected by user");
                    return;
                }

                log::info!("Relay: connection lost, reconnecting in {:?}", backoff);
            }
            Err(e) => {
                log::error!("Relay: connect failed: {}", e);
            }
        }

        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(max_backoff);
    }
}

async fn run_session<S, R>(
    mut ws_sink: S,
    mut ws_stream: R,
    mut rx: mpsc::UnboundedReceiver<String>,
    tx: mpsc::UnboundedSender<String>,
    cancel: tokio_util::sync::CancellationToken,
    relay: &Arc<Mutex<Option<RelayHandle>>>,
    jobs_config: &Arc<Mutex<JobsConfig>>,
    job_status: &Arc<Mutex<HashMap<String, JobStatus>>>,
    secrets: &Arc<Mutex<SecretsManager>>,
    history: &Arc<Mutex<HistoryStore>>,
    settings: &Arc<Mutex<AppSettings>>,
    active_agents: &Arc<Mutex<HashMap<i64, ActiveAgent>>>,
) where
    S: SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    R: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));

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
                        let response = handler::handle_incoming(
                            &text,
                            jobs_config,
                            job_status,
                            secrets,
                            history,
                            settings,
                            active_agents,
                            relay,
                        ).await;
                        if let Some(json) = response {
                            let _ = tx.send(json);
                        }
                    }
                    Ok(Message::Ping(data)) => {
                        let _ = ws_sink.send(Message::Pong(data)).await;
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            _ = heartbeat.tick() => {
                if ws_sink.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
            }
            _ = cancel.cancelled() => break,
        }
    }
}

fn job_to_remote(job: &Job) -> RemoteJob {
    RemoteJob {
        name: job.name.clone(),
        job_type: match job.job_type {
            crate::config::jobs::JobType::Binary => "binary".to_string(),
            crate::config::jobs::JobType::Claude => "claude".to_string(),
            crate::config::jobs::JobType::Folder => "folder".to_string(),
        },
        enabled: job.enabled,
        cron: job.cron.clone(),
        group: job.group.clone(),
        slug: job.slug.clone(),
        work_dir: job.work_dir.clone(),
        path: Some(job.path.clone()),
    }
}

fn status_to_remote(status: &JobStatus) -> RemoteJobStatus {
    match status {
        JobStatus::Idle => RemoteJobStatus::Idle,
        JobStatus::Running {
            run_id, started_at, ..
        } => RemoteJobStatus::Running {
            run_id: run_id.clone(),
            started_at: started_at.clone(),
        },
        JobStatus::Success { last_run } => RemoteJobStatus::Success {
            last_run: last_run.clone(),
        },
        JobStatus::Failed {
            last_run,
            exit_code,
        } => RemoteJobStatus::Failed {
            last_run: last_run.clone(),
            exit_code: *exit_code,
        },
        JobStatus::Paused => RemoteJobStatus::Paused,
    }
}
