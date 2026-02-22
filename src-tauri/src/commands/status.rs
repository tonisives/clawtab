use std::collections::HashMap;

use tauri::State;

use crate::config::jobs::JobStatus;
use crate::AppState;

#[tauri::command]
pub fn get_job_statuses(state: State<AppState>) -> HashMap<String, JobStatus> {
    state.job_status.lock().unwrap().clone()
}

#[tauri::command]
pub fn get_running_job_logs(state: State<AppState>, name: String) -> Result<String, String> {
    let statuses = state.job_status.lock().unwrap();
    let status = statuses.get(&name).ok_or("Job not found")?;

    match status {
        JobStatus::Running {
            pane_id: Some(pane_id),
            tmux_session: Some(session),
            ..
        } => {
            let capture = crate::tmux::capture_pane(session, pane_id, 30)?;
            Ok(capture.trim().to_string())
        }
        JobStatus::Running { .. } => Ok(String::new()),
        _ => Err("Job is not running".to_string()),
    }
}
