use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::terminal;
use crate::tmux;
use crate::AppState;

#[derive(serde::Serialize)]
pub struct ShellPaneResult {
    pub pane_id: String,
    pub cwd: String,
    pub tmux_session: String,
    pub window_name: String,
}

#[tauri::command]
pub fn list_tmux_sessions() -> Result<Vec<String>, String> {
    if !tmux::is_available() {
        return Ok(vec![]);
    }
    tmux::list_sessions()
}

#[tauri::command]
pub fn list_tmux_windows(session: String) -> Result<Vec<tmux::TmuxWindow>, String> {
    tmux::list_windows(&session)
}

#[tauri::command]
pub fn focus_job_window(state: State<AppState>, name: String) -> Result<(), String> {
    let (tmux_session, window_name) = {
        let settings = state.settings.lock().unwrap();

        if name == "agent" {
            let session = settings.default_tmux_session.clone();
            (session, "cwt-agent".to_string())
        } else {
            let config = state.jobs_config.lock().unwrap();
            let job = config
                .jobs
                .iter()
                .find(|j| j.slug == name)
                .ok_or_else(|| format!("Job not found: {}", name))?;

            let session = job
                .tmux_session
                .clone()
                .unwrap_or_else(|| settings.default_tmux_session.clone());

            let project = match job.slug.split_once('/') {
                Some((prefix, _)) if !prefix.is_empty() => prefix.to_string(),
                _ => job.name.clone(),
            };
            (session, format!("cwt-{}", project))
        }
    };

    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    if !tmux::window_exists(&tmux_session, &window_name) {
        return Err(format!(
            "tmux window '{}' not found in session '{}'",
            window_name, tmux_session
        ));
    }

    tmux::focus_window(&tmux_session, &window_name)
}

#[tauri::command]
pub fn open_job_terminal(state: State<AppState>, name: String) -> Result<(), String> {
    let work_dir = {
        let config = state.jobs_config.lock().unwrap();
        let job = config
            .jobs
            .iter()
            .find(|j| j.name == name)
            .ok_or_else(|| format!("Job not found: {}", name))?;

        let settings = state.settings.lock().unwrap();
        job.work_dir
            .clone()
            .unwrap_or_else(|| settings.default_work_dir.clone())
    };

    let cmd = format!("cd {}", work_dir);
    terminal::open_in_terminal(&cmd)
}

/// Fork a Claude Code session by splitting the pane and continuing with --fork-session.
/// `direction` is "right" for horizontal split or "down" for vertical split.
#[tauri::command]
pub async fn fork_pane(pane_id: String, direction: String) -> Result<String, String> {
    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    let horizontal = direction == "right";
    let pane_path = tmux::get_pane_path(&pane_id)?;

    // Send "forking" + ESC ESC to mark this as the most recent session
    tmux::send_keys_to_tui_pane(&pane_id, "forking")?;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let _ = std::process::Command::new("tmux")
        .args(["send-keys", "-t", &pane_id, "Escape", "Escape"])
        .output();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Split pane and launch claude with --continue --fork-session
    let new_pane = tmux::split_pane_by_id(&pane_id, &pane_path, &[], horizontal)?;
    tmux::send_keys_to_pane("", &new_pane, "claude --continue --fork-session")?;

    Ok(new_pane)
}

/// Split a tmux pane without launching Claude (plain terminal).
#[tauri::command]
pub async fn split_pane_plain(
    pane_id: String,
    direction: String,
) -> Result<ShellPaneResult, String> {
    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    let pane_path = tmux::get_pane_path(&pane_id)?;
    let tmux_session = std::process::Command::new("tmux")
        .args(["display-message", "-t", &pane_id, "-p", "#{session_name}"])
        .output()
        .map_err(|e| format!("Failed to get pane session: {}", e))
        .and_then(|output| {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                Err(format!(
                    "tmux error: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ))
            }
        })?;

    let _ = direction;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let window_name = format!("clawtab-shell-{}", suffix);
    let new_pane =
        tmux::create_window_with_cwd(&tmux_session, &window_name, Some(&pane_path), &[])?;

    Ok(ShellPaneResult {
        pane_id: new_pane,
        cwd: pane_path,
        tmux_session,
        window_name,
    })
}

/// Fork a Claude Code session with secrets injected as environment variables.
#[tauri::command]
pub async fn fork_pane_with_secrets(
    state: State<'_, AppState>,
    pane_id: String,
    secret_keys: Vec<String>,
    direction: String,
) -> Result<String, String> {
    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }

    if secret_keys.is_empty() {
        return Err("No secrets selected".to_string());
    }

    let pane_path = tmux::get_pane_path(&pane_id)?;

    // Collect secret values
    let secrets = Arc::clone(&state.secrets);
    let env_vars: Vec<(String, String)> = {
        let store = secrets.lock().unwrap();
        secret_keys
            .iter()
            .filter_map(|key| store.get(key).map(|val| (key.clone(), val.clone())))
            .collect()
    };

    if env_vars.is_empty() {
        return Err("None of the selected secrets were found".to_string());
    }

    // Build the prompt describing injected secrets
    let names_list: Vec<String> = env_vars.iter().map(|(k, _)| format!("${}", k)).collect();
    let prompt = format!("added {} env", names_list.join(", "));

    let horizontal = direction == "right";

    // Send "forking" + ESC ESC to mark this as the most recent session
    tmux::send_keys_to_tui_pane(&pane_id, "forking")?;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let _ = std::process::Command::new("tmux")
        .args(["send-keys", "-t", &pane_id, "Escape", "Escape"])
        .output();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // Split pane with env vars and launch claude
    let new_pane = tmux::split_pane_by_id(&pane_id, &pane_path, &env_vars, horizontal)?;
    let cmd = format!("claude --continue --fork-session '{}'", prompt);
    tmux::send_keys_to_pane("", &new_pane, &cmd)?;

    Ok(new_pane)
}
