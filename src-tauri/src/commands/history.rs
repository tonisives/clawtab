use tauri::State;

use crate::history::RunRecord;
use crate::AppState;

#[tauri::command]
pub fn get_history(state: State<AppState>) -> Result<Vec<RunRecord>, String> {
    let history = state.history.lock().unwrap();
    history.get_recent(100)
}

#[tauri::command]
pub fn get_run_detail(state: State<AppState>, id: String) -> Result<Option<RunRecord>, String> {
    let history = state.history.lock().unwrap();
    history.get_by_id(&id)
}

#[tauri::command]
pub fn clear_history(state: State<AppState>) -> Result<(), String> {
    let history = state.history.lock().unwrap();
    history.clear()
}
