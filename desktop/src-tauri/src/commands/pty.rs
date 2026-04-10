use base64::Engine;
use serde::Serialize;
use tauri::State;

use crate::AppState;

#[derive(Serialize)]
pub struct PtySpawnResult {
    pub native_cols: u16,
    pub native_rows: u16,
    pub attach_generation: u64,
}

#[tauri::command]
pub fn pty_spawn(
    state: State<AppState>,
    app: tauri::AppHandle,
    pane_id: String,
    tmux_session: String,
    cols: u16,
    rows: u16,
    group: String,
) -> Result<PtySpawnResult, String> {
    let result = state.pty_manager.lock().unwrap().spawn(
        &pane_id,
        &tmux_session,
        cols,
        rows,
        &group,
        crate::pty::OutputSink::Tauri(app),
    )?;
    Ok(PtySpawnResult {
        native_cols: result.native_cols,
        native_rows: result.native_rows,
        attach_generation: result.attach_generation,
    })
}

#[tauri::command]
pub fn pty_release(state: State<AppState>, pane_id: String) -> Result<(), String> {
    state.pty_manager.lock().unwrap().release(&pane_id)
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
pub fn pty_destroy(
    state: State<AppState>,
    pane_id: String,
    attach_generation: Option<u64>,
) -> Result<(), String> {
    state
        .pty_manager
        .lock()
        .unwrap()
        .destroy(&pane_id, attach_generation)
}

#[tauri::command]
pub fn pty_get_cached_output(state: State<AppState>, pane_id: String) -> Result<Vec<u8>, String> {
    Ok(state
        .pty_manager
        .lock()
        .unwrap()
        .get_cached_output(&pane_id))
}
