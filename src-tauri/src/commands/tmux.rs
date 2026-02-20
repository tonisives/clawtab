use tauri::State;

use crate::tmux;
use crate::terminal;
use crate::AppState;

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
        let config = state.jobs_config.lock().unwrap();
        let job = config
            .jobs
            .iter()
            .find(|j| j.name == name)
            .ok_or_else(|| format!("Job not found: {}", name))?;

        let settings = state.settings.lock().unwrap();
        let session = job
            .tmux_session
            .clone()
            .unwrap_or_else(|| settings.default_tmux_session.clone());

        (session, format!("cwt-{}", job.name))
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

    tmux::focus_window(&tmux_session, &window_name)?;

    // Open a terminal attached to the session so the user can see it
    terminal::open_tmux_in_terminal(&tmux_session)
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
