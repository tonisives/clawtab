use std::sync::Arc;
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

/// Fork a Claude Code session by creating a new ct-* window and running
/// `claude --continue --fork-session`. `direction` is kept for the frontend's
/// virtual split tree but not applied at the tmux level: every clawtab-managed
/// pane must live alone in its own ct-* window.
///
/// When `secret_keys` is non-empty, the matching values from the secret store
/// are injected as env vars on the new window and their names are appended to
/// the fork prompt so the forked session sees `added $FOO, $BAR env`.
#[tauri::command]
pub async fn fork_pane(
    state: State<'_, AppState>,
    pane_id: String,
    direction: String,
    secret_keys: Option<Vec<String>>,
) -> Result<String, String> {
    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }
    let _ = direction;

    let secret_keys = secret_keys.unwrap_or_default();
    let env_vars: Vec<(String, String)> = if secret_keys.is_empty() {
        Vec::new()
    } else {
        let secrets = Arc::clone(&state.secrets);
        let store = secrets.lock().unwrap();
        let vars: Vec<(String, String)> = secret_keys
            .iter()
            .filter_map(|k| store.get(k).map(|v| (k.clone(), v.clone())))
            .collect();
        if vars.is_empty() {
            return Err("None of the selected secrets were found".to_string());
        }
        vars
    };

    let pane_path = tmux::get_pane_path(&pane_id)?;
    let target_session = tmux::resolve_fork_session(&pane_id)?;

    tmux::mark_pane_as_forking(&pane_id).await?;

    let (new_pane, _window_name) = state.pty_manager.lock().unwrap().spawn_window(
        &target_session,
        "ct-fork",
        Some(&pane_path),
        &env_vars,
    )?;

    let cmd = if env_vars.is_empty() {
        "claude --continue --fork-session".to_string()
    } else {
        let names_list: Vec<String> = env_vars.iter().map(|(k, _)| format!("${}", k)).collect();
        format!(
            "claude --continue --fork-session 'added {} env'",
            names_list.join(", ")
        )
    };
    tmux::send_keys_to_pane("", &new_pane, &cmd)?;

    Ok(new_pane)
}

/// Split a tmux pane without launching Claude (plain terminal).
#[tauri::command]
pub async fn split_pane_plain(
    state: State<'_, AppState>,
    pane_id: String,
    direction: String,
) -> Result<ShellPaneResult, String> {
    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }
    let _ = direction;

    let pane_path = tmux::get_pane_path(&pane_id)?;
    let tmux_session = tmux::resolve_real_session_for_pane(&pane_id)?;

    let (new_pane, window_name) = state.pty_manager.lock().unwrap().spawn_window(
        &tmux_session,
        "clawtab-shell",
        Some(&pane_path),
        &[],
    )?;

    Ok(ShellPaneResult {
        pane_id: new_pane,
        cwd: pane_path,
        tmux_session,
        window_name,
    })
}
