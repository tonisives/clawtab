use serde::Serialize;
use tauri::State;

use crate::AppState;
use crate::daemon;

#[derive(Serialize)]
pub struct DaemonStatus {
    installed: bool,
    running: bool,
    pid: Option<u32>,
    ui_only_mode: bool,
}

#[tauri::command]
pub fn get_daemon_status(state: State<AppState>) -> DaemonStatus {
    let installed = daemon::is_installed();
    let (running, pid) = daemon::is_running();
    let ui_only_mode = *state.ui_only_mode.lock().unwrap();
    DaemonStatus { installed, running, pid, ui_only_mode }
}

#[tauri::command]
pub fn daemon_install() -> Result<String, String> {
    daemon::install()
}

#[tauri::command]
pub fn daemon_uninstall() -> Result<String, String> {
    daemon::uninstall()
}

#[tauri::command]
pub fn daemon_restart() -> Result<String, String> {
    daemon::restart()
}

#[tauri::command]
pub fn get_daemon_logs(lines: Option<usize>) -> String {
    let path = "/tmp/clawtab/daemon.stderr.log";
    let n = lines.unwrap_or(100);
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let all: Vec<&str> = content.lines().collect();
            let start = all.len().saturating_sub(n);
            all[start..].join("\n")
        }
        Err(_) => String::new(),
    }
}
