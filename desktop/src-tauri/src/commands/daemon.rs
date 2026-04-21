use serde::Serialize;

use crate::daemon;

#[derive(Serialize)]
pub struct DaemonStatus {
    installed: bool,
    running: bool,
    pid: Option<u32>,
}

#[tauri::command]
pub fn get_daemon_status() -> DaemonStatus {
    let installed = daemon::is_installed();
    let (running, pid) = daemon::is_running();
    DaemonStatus {
        installed,
        running,
        pid,
    }
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
