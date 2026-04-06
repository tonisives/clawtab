use base64::Engine;
use serde::Serialize;
use tauri::State;

use crate::AppState;

#[derive(Serialize)]
pub struct PtySpawnResult {
    pub native_cols: u16,
    pub native_rows: u16,
}

#[tauri::command]
pub fn pty_spawn(
    state: State<AppState>,
    app: tauri::AppHandle,
    pane_id: String,
    tmux_session: String,
    cols: u16,
    rows: u16,
) -> Result<PtySpawnResult, String> {
    let result = state
        .pty_manager
        .lock()
        .unwrap()
        .spawn(&pane_id, &tmux_session, cols, rows, crate::pty::OutputSink::Tauri(app))?;
    Ok(PtySpawnResult {
        native_cols: result.native_cols,
        native_rows: result.native_rows,
    })
}

#[tauri::command]
pub fn pty_write(state: State<AppState>, pane_id: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    state.pty_manager.lock().unwrap().write(&pane_id, &bytes)
}

#[tauri::command]
pub fn pty_resize(
    state: State<AppState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .pty_manager
        .lock()
        .unwrap()
        .resize(&pane_id, cols, rows)
}

#[tauri::command]
pub fn pty_restore_size(state: State<AppState>, pane_id: String) -> Result<(), String> {
    state.pty_manager.lock().unwrap().restore_size(&pane_id)
}

#[tauri::command]
pub fn pty_destroy(state: State<AppState>, pane_id: String) -> Result<(), String> {
    state.pty_manager.lock().unwrap().destroy(&pane_id)
}
