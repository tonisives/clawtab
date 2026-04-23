use std::collections::HashMap;

use tauri::State;

use crate::config::jobs::JobStatus;
use crate::AppState;

#[tauri::command]
pub async fn get_job_statuses(
    _state: State<'_, AppState>,
) -> Result<HashMap<String, JobStatus>, String> {
    match crate::ipc::send_command(crate::ipc::IpcCommand::GetStatus).await {
        Ok(crate::ipc::IpcResponse::Status(s)) => Ok(s),
        Ok(resp) => Err(format!("Unexpected IPC response: {:?}", resp)),
        Err(e) => Err(format!("Daemon unavailable: {}", e)),
    }
}

async fn get_status_via_ipc(name: &str) -> Result<JobStatus, String> {
    match crate::ipc::send_command(crate::ipc::IpcCommand::GetStatus).await {
        Ok(crate::ipc::IpcResponse::Status(mut s)) => {
            s.remove(name).ok_or_else(|| "Job not found".to_string())
        }
        Ok(resp) => Err(format!("Unexpected IPC response: {:?}", resp)),
        Err(e) => Err(format!("Daemon unavailable: {}", e)),
    }
}

#[tauri::command]
pub async fn get_running_job_logs(
    _state: State<'_, AppState>,
    name: String,
) -> Result<String, String> {
    let status = get_status_via_ipc(&name).await?;
    match status {
        JobStatus::Running {
            pane_id: Some(pane_id),
            tmux_session: Some(session),
            ..
        } => {
            let capture = crate::tmux::capture_pane(&session, &pane_id, 200)?;
            Ok(capture.trim().to_string())
        }
        JobStatus::Running { .. } => Ok(String::new()),
        _ => Err("Job is not running".to_string()),
    }
}

#[tauri::command]
pub async fn send_job_input(
    _state: State<'_, AppState>,
    name: String,
    text: String,
    freetext: Option<String>,
    col: Option<u16>,
    row: Option<u16>,
) -> Result<(), String> {
    let status = get_status_via_ipc(&name).await?;
    match status {
        JobStatus::Running {
            pane_id: Some(pane_id),
            ..
        } => {
            if let (Some(c), Some(r)) = (col, row) {
                crate::tmux::send_mouse_click_to_pane(&pane_id, c, r)
            } else if let Some(ref ft) = freetext {
                crate::tmux::send_keys_to_tui_pane_freetext(&pane_id, &text, ft)
            } else {
                crate::tmux::send_keys_to_tui_pane(&pane_id, &text)
            }
        }
        JobStatus::Running { .. } => Err("Job has no tmux pane".to_string()),
        _ => Err("Job is not running".to_string()),
    }
}
