use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex as AsyncMutex;

pub fn daemon_socket_path() -> PathBuf {
    PathBuf::from("/tmp/clawtab.sock")
}

pub fn daemon_event_socket_path() -> PathBuf {
    PathBuf::from("/tmp/clawtab-events.sock")
}

pub fn desktop_socket_path() -> PathBuf {
    PathBuf::from("/tmp/clawtab-desktop.sock")
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

/// Direction for pane focus changes. Used by external integrations
/// (vim/tmux configs) calling into the desktop app via cwtctl.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneDirection {
    Left,
    Right,
    Up,
    Down,
}

/// Commands sent to the desktop app's UI socket. The daemon doesn't handle
/// these - they require the GUI process. Kept separate from IpcCommand so the
/// daemon never deserializes UI variants.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum DesktopIpcCommand {
    FocusPane { direction: PaneDirection },
    OpenPane { pane_id: String },
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

/// Shared response type for both the daemon and desktop sockets. The desktop
/// handler only ever returns `Ok` or `Error(String)`; the richer variants are
/// daemon-only. This keeps the wire format symmetric and lets cwtctl reuse one
/// big response match regardless of which socket it talked to.
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

/// Generic request/response Unix-socket server. Handler is parameterized over
/// the command and response types, so the same loop serves both the daemon
/// socket (`IpcCommand` -> `IpcResponse`) and the desktop socket
/// (`DesktopIpcCommand` -> `IpcResponse`).
async fn run_server<C, R, F, Fut>(path: PathBuf, handler: F) -> Result<(), String>
where
    C: serde::de::DeserializeOwned + Send + 'static,
    R: serde::Serialize + Send + 'static,
    F: Fn(C) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = R> + Send + 'static,
{
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
                    if let Err(e) = handle_client::<C, R, F, Fut>(stream, handler).await {
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

pub async fn start_ipc_server<F, Fut>(handler: F) -> Result<(), String>
where
    F: Fn(IpcCommand) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = IpcResponse> + Send + 'static,
{
    run_server::<IpcCommand, IpcResponse, _, _>(daemon_socket_path(), handler).await
}

pub async fn start_desktop_ipc_server<F, Fut>(handler: F) -> Result<(), String>
where
    F: Fn(DesktopIpcCommand) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = IpcResponse> + Send + 'static,
{
    run_server::<DesktopIpcCommand, IpcResponse, _, _>(desktop_socket_path(), handler).await
}

/// Start the event-push server. Clients connect, the daemon pushes newline-
/// delimited JSON `IpcEvent` values. No request/response; the client just reads.
pub async fn start_event_server(subs: EventSubscribers) -> Result<(), String> {
    let path = daemon_event_socket_path();
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

async fn handle_client<C, R, F, Fut>(
    stream: UnixStream,
    handler: std::sync::Arc<F>,
) -> Result<(), String>
where
    C: serde::de::DeserializeOwned,
    R: serde::Serialize,
    F: Fn(C) -> Fut,
    Fut: std::future::Future<Output = R>,
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

        let cmd: C =
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

/// Generic single-shot client send. Used by both daemon and desktop wrappers.
async fn send<C, R>(path: PathBuf, cmd: C) -> Result<R, String>
where
    C: serde::Serialize,
    R: serde::de::DeserializeOwned,
{
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

    let response: R =
        serde_json::from_str(line.trim()).map_err(|e| format!("Invalid response: {}", e))?;

    Ok(response)
}

pub async fn send_command(cmd: IpcCommand) -> Result<IpcResponse, String> {
    send(daemon_socket_path(), cmd).await
}

pub async fn send_desktop_command(cmd: DesktopIpcCommand) -> Result<IpcResponse, String> {
    send(desktop_socket_path(), cmd).await
}

/// Connect to the daemon's event server. Returns a reader yielding newline-
/// delimited `IpcEvent` JSON. Caller parses each line and dispatches.
pub async fn subscribe_events() -> Result<BufReader<tokio::net::unix::OwnedReadHalf>, String> {
    let path = daemon_event_socket_path();
    let stream = UnixStream::connect(&path)
        .await
        .map_err(|e| format!("Failed to connect to event server: {}", e))?;
    let (read, _write) = stream.into_split();
    Ok(BufReader::new(read))
}
