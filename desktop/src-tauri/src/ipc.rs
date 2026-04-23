use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex as AsyncMutex;

pub fn socket_path() -> PathBuf {
    PathBuf::from("/tmp/clawtab.sock")
}

pub fn event_socket_path() -> PathBuf {
    PathBuf::from("/tmp/clawtab-events.sock")
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum IpcCommand {
    Ping,
    ListJobs,
    RunJob { name: String },
    PauseJob { name: String },
    ResumeJob { name: String },
    RestartJob { name: String },
    GetStatus,
    OpenSettings,
    OpenPane { pane_id: String },
    GetAutoYesPanes,
    SetAutoYesPanes { pane_ids: Vec<String> },
    ToggleAutoYes { pane_id: String },
    GetActiveQuestions,
    ListSecretKeys,
    GetSecretValues { keys: Vec<String> },
    GetPaneInfo { pane_id: String },

    // Relay state + control
    GetRelayStatus,
    RelayConnect,
    RelayDisconnect,

    // Settings
    ReloadSettings,

    // Job lifecycle (state-touching)
    StopJob { name: String },
    ToggleJob { name: String },
    DeleteJob { name: String },

    // Answer questions from UI (cross-process)
    AnswerQuestion { pane_id: String, answer: String },
    DismissQuestion { pane_id: String },

    // Manual run from UI, expects pane info back
    RunJobNow {
        name: String,
        params: std::collections::HashMap<String, String>,
    },
    SigintJob {
        name: String,
    },
    RunAgent {
        prompt: String,
        work_dir: Option<String>,
        provider: Option<crate::agent_session::ProcessProvider>,
        model: Option<String>,
    },
    SetProtectedPanes {
        pane_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct IpcRelayStatus {
    pub enabled: bool,
    pub connected: bool,
    pub subscription_required: bool,
    pub auth_expired: bool,
    pub configured: bool,
    pub server_url: String,
    pub device_name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum IpcResponse {
    Pong,
    Ok,
    Jobs(Vec<String>),
    Status(std::collections::HashMap<String, crate::config::jobs::JobStatus>),
    AutoYesPanes(Vec<String>),
    ActiveQuestions(Vec<clawtab_protocol::ClaudeQuestion>),
    SecretKeys(Vec<String>),
    SecretValues(Vec<(String, String)>),
    PaneInfo {
        first_query: Option<String>,
        last_query: Option<String>,
        session_started_at: Option<String>,
    },
    RelayStatus(IpcRelayStatus),
    PaneCreated {
        pane_id: Option<String>,
        tmux_session: Option<String>,
    },
    Error(String),
}

/// Events pushed from the daemon to subscribed desktop clients.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum IpcEvent {
    JobsChanged,
    AutoYesChanged,
    MissedCronJobs(Vec<String>),
    JobStatusChanged {
        name: String,
        status: crate::config::jobs::JobStatus,
    },
    QuestionsChanged,
    RelayStatusChanged(IpcRelayStatus),
}

/// Registry of connected event subscribers. Each entry is a write half of a
/// Unix stream. Dropped on send failure.
pub type EventSubscribers = Arc<AsyncMutex<Vec<tokio::net::unix::OwnedWriteHalf>>>;

pub fn new_event_subscribers() -> EventSubscribers {
    Arc::new(AsyncMutex::new(Vec::new()))
}

pub async fn broadcast_event(subs: &EventSubscribers, event: &IpcEvent) {
    let serialized = match serde_json::to_string(event) {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to serialize IPC event: {}", e);
            return;
        }
    };
    let payload = format!("{}\n", serialized);

    let mut guard = subs.lock().await;
    let mut i = 0;
    while i < guard.len() {
        let res = {
            let writer = &mut guard[i];
            let write_res = writer.write_all(payload.as_bytes()).await;
            if write_res.is_ok() {
                writer.flush().await
            } else {
                write_res
            }
        };
        if res.is_err() {
            guard.swap_remove(i);
        } else {
            i += 1;
        }
    }
}

pub async fn start_ipc_server<F, Fut>(handler: F) -> Result<(), String>
where
    F: Fn(IpcCommand) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = IpcResponse> + Send + 'static,
{
    let path = socket_path();
    let _ = std::fs::remove_file(&path);

    let listener =
        UnixListener::bind(&path).map_err(|e| format!("Failed to bind socket: {}", e))?;

    log::info!("IPC server listening on {:?}", path);

    let handler = std::sync::Arc::new(handler);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let handler = handler.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_client(stream, handler).await {
                        log::error!("Error handling IPC client: {}", e);
                    }
                });
            }
            Err(e) => {
                log::error!("Error accepting IPC connection: {}", e);
            }
        }
    }
}

/// Start the event-push server. Clients connect, the daemon pushes newline-
/// delimited JSON `IpcEvent` values. No request/response; the client just reads.
pub async fn start_event_server(subs: EventSubscribers) -> Result<(), String> {
    let path = event_socket_path();
    let _ = std::fs::remove_file(&path);

    let listener =
        UnixListener::bind(&path).map_err(|e| format!("Failed to bind event socket: {}", e))?;

    log::info!("IPC event server listening on {:?}", path);

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let (_read, write) = stream.into_split();
                let mut guard = subs.lock().await;
                guard.push(write);
                log::debug!("IPC event subscriber connected ({} total)", guard.len());
            }
            Err(e) => {
                log::error!("Error accepting event subscriber: {}", e);
            }
        }
    }
}

async fn handle_client<F, Fut>(stream: UnixStream, handler: std::sync::Arc<F>) -> Result<(), String>
where
    F: Fn(IpcCommand) -> Fut,
    Fut: std::future::Future<Output = IpcResponse>,
{
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    while reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?
        > 0
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            line.clear();
            continue;
        }

        let cmd: IpcCommand =
            serde_json::from_str(trimmed).map_err(|e| format!("Invalid command: {}", e))?;

        let response = handler(cmd).await;
        let response_str = serde_json::to_string(&response).map_err(|e| e.to_string())?;

        writer
            .write_all(response_str.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        writer.write_all(b"\n").await.map_err(|e| e.to_string())?;
        writer.flush().await.map_err(|e| e.to_string())?;

        line.clear();
    }

    Ok(())
}

pub async fn send_command(cmd: IpcCommand) -> Result<IpcResponse, String> {
    let path = socket_path();

    let stream = UnixStream::connect(&path)
        .await
        .map_err(|e| format!("Failed to connect (is clawtab running?): {}", e))?;

    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);

    let cmd_str = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
    writer
        .write_all(cmd_str.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    writer.write_all(b"\n").await.map_err(|e| e.to_string())?;
    writer.flush().await.map_err(|e| e.to_string())?;

    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| e.to_string())?;

    let response: IpcResponse =
        serde_json::from_str(line.trim()).map_err(|e| format!("Invalid response: {}", e))?;

    Ok(response)
}

/// Connect to the daemon's event server. Returns a reader yielding newline-
/// delimited `IpcEvent` JSON. Caller parses each line and dispatches.
pub async fn subscribe_events() -> Result<BufReader<tokio::net::unix::OwnedReadHalf>, String> {
    let path = event_socket_path();
    let stream = UnixStream::connect(&path)
        .await
        .map_err(|e| format!("Failed to connect to event server: {}", e))?;
    let (read, _write) = stream.into_split();
    Ok(BufReader::new(read))
}
