use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

pub fn socket_path() -> PathBuf {
    PathBuf::from("/tmp/clawtab.sock")
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
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum IpcResponse {
    Pong,
    Ok,
    Jobs(Vec<String>),
    Status(std::collections::HashMap<String, crate::config::jobs::JobStatus>),
    Error(String),
}

pub async fn start_ipc_server<F>(handler: F) -> Result<(), String>
where
    F: Fn(IpcCommand) -> IpcResponse + Send + Sync + 'static,
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

async fn handle_client<F>(stream: UnixStream, handler: std::sync::Arc<F>) -> Result<(), String>
where
    F: Fn(IpcCommand) -> IpcResponse,
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

        let response = handler(cmd);
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
