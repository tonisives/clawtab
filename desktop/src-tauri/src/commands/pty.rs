use std::collections::HashSet;

use base64::Engine;
use serde::Serialize;
use tauri::State;

use crate::debug_spawn;
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

#[derive(Serialize)]
pub struct FreePaneInfo {
    pub pane_id: String,
    pub session: String,
    pub window_index: String,
    pub window_name: String,
    pub width: u16,
    pub height: u16,
    pub command: String,
}

#[derive(Serialize)]
pub struct CapturedPaneInfo {
    pub pane_id: String,
    pub capture_session: String,
    pub window_id: String,
    pub window_name: String,
    pub origin_session: String,
    pub origin_window_name: String,
    pub command: String,
    pub width: u16,
    pub height: u16,
}

fn list_panes_raw(callsite: &'static str) -> Result<String, String> {
    let output = debug_spawn::run_logged(
        "tmux",
        &[
            "list-panes",
            "-a",
            "-F",
            "#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_width}\t#{pane_height}\t#{pane_current_command}\t#{window_id}",
        ],
        callsite,
    )
    .map_err(|e| format!("tmux list-panes: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no server running") || stderr.contains("no sessions") {
            return Ok(String::new());
        }
        return Err(format!("tmux list-panes: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub fn list_free_panes() -> Result<Vec<FreePaneInfo>, String> {
    let raw = list_panes_raw("pty::list_free_panes")?;
    let mut panes = Vec::new();
    let mut seen = HashSet::new();
    for line in raw.lines() {
        let p: Vec<&str> = line.split('\t').collect();
        if p.len() < 7 {
            continue;
        }
        let session = p[1];
        if session.starts_with("clawtab-") {
            continue;
        }
        if !seen.insert(p[0].to_string()) {
            continue;
        }
        panes.push(FreePaneInfo {
            pane_id: p[0].to_string(),
            session: session.to_string(),
            window_index: p[2].to_string(),
            window_name: p[3].to_string(),
            width: p[4].parse().unwrap_or(0),
            height: p[5].parse().unwrap_or(0),
            command: p[6].to_string(),
        });
    }
    Ok(panes)
}

#[tauri::command]
pub fn list_captured_panes() -> Result<Vec<CapturedPaneInfo>, String> {
    let raw = list_panes_raw("pty::list_captured_panes")?;
    let mut panes = Vec::new();
    let mut seen = HashSet::new();
    for line in raw.lines() {
        let p: Vec<&str> = line.split('\t').collect();
        if p.len() < 8 {
            continue;
        }
        let session = p[1];
        if !session.starts_with("clawtab-") {
            continue;
        }
        // Skip ephemeral grouped view sessions (they duplicate windows from the base session).
        if session.contains("-view-") {
            continue;
        }
        if !seen.insert(p[0].to_string()) {
            continue;
        }
        let window_name = p[3];
        if window_name == "__placeholder" {
            continue;
        }
        let origin = debug_spawn::run_logged(
            "tmux",
            &["show-options", "-w", "-v", "-t", p[7], "@clawtab-origin"],
            "pty::list_captured_panes::show-origin",
        )
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_default();
        let origin_parts: Vec<&str> = origin.split('\t').collect();
        let origin_session = origin_parts.first().copied().unwrap_or("").to_string();
        let origin_window_name = origin_parts.get(3).copied().unwrap_or("").to_string();
        panes.push(CapturedPaneInfo {
            pane_id: p[0].to_string(),
            capture_session: session.to_string(),
            window_id: p[7].to_string(),
            window_name: window_name.to_string(),
            origin_session,
            origin_window_name,
            command: p[6].to_string(),
            width: p[4].parse().unwrap_or(0),
            height: p[5].parse().unwrap_or(0),
        });
    }
    Ok(panes)
}
