use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

use crate::debug_spawn;
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

#[derive(serde::Serialize, Clone)]
pub struct TmuxDebugWindow {
    pub session: String,
    pub index: u32,
    pub name: String,
    pub window_id: String,
    pub active: bool,
    pub pane_count: u32,
    pub active_pane_id: String,
    pub active_command: String,
    pub clawtab_origin: String,
}

#[derive(serde::Serialize)]
pub struct TmuxDebugSnapshot {
    pub sessions: Vec<String>,
    pub windows: Vec<TmuxDebugWindow>,
}

#[derive(serde::Serialize)]
pub struct TmuxMoveResult {
    pub moved: Vec<String>,
    pub skipped: Vec<String>,
}

fn tmux_capture(args: &[&str], callsite: &'static str) -> Result<String, String> {
    let output = debug_spawn::run_logged("tmux", args, callsite)
        .map_err(|e| format!("tmux {}: {}", args.first().copied().unwrap_or(""), e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no server running") || stderr.contains("no sessions") {
            return Ok(String::new());
        }
        return Err(format!(
            "tmux {}: {}",
            args.first().copied().unwrap_or(""),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn tmux_ok(args: &[&str], callsite: &'static str) -> Result<(), String> {
    tmux_capture(args, callsite).map(|_| ())
}

fn is_clawtab_view_session(session: &str) -> bool {
    session.starts_with("clawtab-") && session.contains("-view-")
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
pub fn list_tmux_debug_windows() -> Result<TmuxDebugSnapshot, String> {
    if !tmux::is_available() {
        return Ok(TmuxDebugSnapshot {
            sessions: vec![],
            windows: vec![],
        });
    }

    let session_raw = tmux_capture(
        &["list-sessions", "-F", "#{session_name}"],
        "commands::tmux::list_tmux_debug_windows::sessions",
    )?;
    let sessions: Vec<String> = session_raw
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !is_clawtab_view_session(s))
        .map(str::to_string)
        .collect();

    let raw = tmux_capture(
        &[
            "list-windows",
            "-a",
            "-F",
            "#{session_name}\x1e#{window_index}\x1e#{window_name}\x1e#{window_id}\x1e#{window_active}\x1e#{window_panes}\x1e#{pane_id}\x1e#{pane_current_command}\x1e#{@clawtab-origin}",
        ],
        "commands::tmux::list_tmux_debug_windows::windows",
    )?;

    let mut windows = Vec::new();
    let mut seen = HashSet::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\x1e').collect();
        if parts.len() < 9 {
            continue;
        }
        let session = parts[0].trim();
        let window_id = parts[3].trim();
        if session.is_empty() || window_id.is_empty() || is_clawtab_view_session(session) {
            continue;
        }
        if !seen.insert((session.to_string(), window_id.to_string())) {
            continue;
        }
        windows.push(TmuxDebugWindow {
            session: session.to_string(),
            index: parts[1].parse().unwrap_or(0),
            name: parts[2].to_string(),
            window_id: window_id.to_string(),
            active: parts[4] == "1",
            pane_count: parts[5].parse().unwrap_or(0),
            active_pane_id: parts[6].to_string(),
            active_command: parts[7].to_string(),
            clawtab_origin: parts[8].to_string(),
        });
    }

    windows.sort_by(|a, b| {
        a.session
            .cmp(&b.session)
            .then(a.index.cmp(&b.index))
            .then(a.window_id.cmp(&b.window_id))
    });

    Ok(TmuxDebugSnapshot { sessions, windows })
}

#[tauri::command]
pub fn move_tmux_windows_to_session(
    window_ids: Vec<String>,
    target_session: String,
) -> Result<TmuxMoveResult, String> {
    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }
    let target_session = target_session.trim().to_string();
    if target_session.is_empty() {
        return Err("target session is required".to_string());
    }
    if is_clawtab_view_session(&target_session) {
        return Err("cannot move windows into a ClawTab view session".to_string());
    }

    let snapshot = list_tmux_debug_windows()?;
    if !snapshot.sessions.iter().any(|s| s == &target_session) {
        return Err(format!("tmux session not found: {}", target_session));
    }
    let mut next_target_index = snapshot
        .windows
        .iter()
        .filter(|w| w.session == target_session)
        .map(|w| w.index)
        .max()
        .unwrap_or(0)
        .saturating_add(1);

    let requested: HashSet<String> = window_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if requested.is_empty() {
        return Err("select at least one window".to_string());
    }

    let mut rows_by_id: HashMap<String, Vec<TmuxDebugWindow>> = HashMap::new();
    for window in snapshot.windows {
        if requested.contains(&window.window_id) {
            rows_by_id
                .entry(window.window_id.clone())
                .or_default()
                .push(window);
        }
    }

    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    for window_id in requested {
        let Some(rows) = rows_by_id.get(&window_id) else {
            skipped.push(format!("{} (not found)", window_id));
            continue;
        };
        if rows.iter().any(|w| w.session == target_session) {
            skipped.push(format!("{} (already in {})", window_id, target_session));
            continue;
        }
        let source = rows
            .iter()
            .min_by_key(|w| (w.session.clone(), w.index))
            .cloned()
            .unwrap();
        candidates.push(source);
    }

    candidates.sort_by(|a, b| {
        a.session
            .cmp(&b.session)
            .then(a.index.cmp(&b.index))
            .then(a.window_id.cmp(&b.window_id))
    });

    let mut touched_sessions: HashSet<String> = HashSet::new();
    let mut moved = Vec::new();
    for window in candidates {
        let target = format!("{}:{}", target_session, next_target_index);
        tmux_ok(
            &["move-window", "-d", "-s", &window.window_id, "-t", &target],
            "commands::tmux::move_tmux_windows_to_session::move",
        )?;
        next_target_index = next_target_index.saturating_add(1);
        touched_sessions.insert(window.session);
        touched_sessions.insert(target_session.clone());
        moved.push(window.window_id);
    }

    for session in touched_sessions {
        let _ = tmux_ok(
            &["move-window", "-r", "-t", &session],
            "commands::tmux::move_tmux_windows_to_session::renumber",
        );
    }

    Ok(TmuxMoveResult { moved, skipped })
}

#[tauri::command]
pub fn focus_job_window(state: State<AppState>, name: String) -> Result<(), String> {
    let (tmux_session, window_name) = {
        let settings = state.settings.lock();

        if name == "agent" {
            let session = settings.default_tmux_session.clone();
            (session, "cwt-agent".to_string())
        } else {
            let config = state.jobs_config.lock();
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
        let config = state.jobs_config.lock();
        let job = config
            .jobs
            .iter()
            .find(|j| j.name == name)
            .ok_or_else(|| format!("Job not found: {}", name))?;

        let settings = state.settings.lock();
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
        let store = secrets.lock();
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

    let (new_pane, _window_name) = state.pty_manager.lock().spawn_window(
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

/// Split a tmux pane and run an initial command in the new pane. The new pane
/// uses `cwd` as its working directory if provided, otherwise it inherits the
/// source pane's path. Used to resume a Claude session in a new split.
#[tauri::command]
pub async fn split_pane_with_command(
    state: State<'_, AppState>,
    pane_id: String,
    direction: String,
    command: String,
    cwd: Option<String>,
) -> Result<ShellPaneResult, String> {
    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }
    let _ = direction;

    let source_path = tmux::get_pane_path(&pane_id)?;
    let pane_path = cwd
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or(source_path);
    let tmux_session = tmux::resolve_real_session_for_pane(&pane_id)?;

    let (new_pane, window_name) = state.pty_manager.lock().spawn_window(
        &tmux_session,
        "clawtab-shell",
        Some(&pane_path),
        &[],
    )?;

    if !command.trim().is_empty() {
        tmux::send_keys_to_pane("", &new_pane, &command)?;
    }

    Ok(ShellPaneResult {
        pane_id: new_pane,
        cwd: pane_path,
        tmux_session,
        window_name,
    })
}

/// Enter tmux copy-mode for the given pane.
#[tauri::command]
pub fn enter_copy_mode(pane_id: String) -> Result<(), String> {
    if !tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }
    tmux::enter_copy_mode(&pane_id)
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

    let (new_pane, window_name) = state.pty_manager.lock().spawn_window(
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
