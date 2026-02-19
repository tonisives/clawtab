use std::collections::HashMap;

use tauri::State;

use crate::config::jobs::JobStatus;
use crate::AppState;

#[tauri::command]
pub fn get_job_statuses(state: State<AppState>) -> HashMap<String, JobStatus> {
    state.job_status.lock().unwrap().clone()
}
