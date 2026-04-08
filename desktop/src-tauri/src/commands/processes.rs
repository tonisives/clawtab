use std::collections::HashSet;
use std::process::Command;

use clawtab_protocol::DesktopMessage;

use serde::Serialize;
use tauri::State;

use crate::config::jobs::JobStatus;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct ClaudeProcess {
    pub pane_id: String,
    pub cwd: String,
    pub version: String,
    pub process_type: Option<String>,
    pub tmux_session: String,
    pub window_name: String,
    pub matched_group: Option<String>,
    pub matched_job: Option<String>,
    pub log_lines: String,
    pub first_query: Option<String>,
    pub last_query: Option<String>,
    pub session_started_at: Option<String>,
}

fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn detect_process_type(pane_pid: &str) -> Option<String> {
    fn command_for_pid(pid: &str) -> Option<String> {
        let output = Command::new("ps")
            .args(["-p", pid, "-o", "comm="])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn child_pids(parent_pid: &str) -> Vec<String> {
        let output = match Command::new("ps")
            .args(["-o", "pid=,ppid="])
            .arg("-A")
            .output()
        {
            Ok(o) if o.status.success() => o,
            _ => return Vec::new(),
        };

        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 2 && parts[1] == parent_pid {
                    Some(parts[0].to_string())
                } else {
                    None
                }
            })
            .collect()
    }

    fn process_type_for_command(command: &str) -> Option<String> {
        let lower = command.to_lowercase();
        if lower.contains("codex") {
            Some("codex".to_string())
        } else if lower.contains("claude") && !lower.contains("claude.app") {
            Some("claude".to_string())
        } else {
            None
        }
    }

    if let Some(command) = command_for_pid(pane_pid) {
        if let Some(kind) = process_type_for_command(&command) {
            return Some(kind);
        }
    }

    for child in child_pids(pane_pid) {
        if let Some(command) = command_for_pid(&child) {
            if let Some(kind) = process_type_for_command(&command) {
                return Some(kind);
            }
        }

        for grandchild in child_pids(&child) {
            if let Some(command) = command_for_pid(&grandchild) {
                if let Some(kind) = process_type_for_command(&command) {
                    return Some(kind);
                }
            }
        }
    }

    None
}

#[tauri::command]
pub async fn detect_claude_processes(state: State<'_, AppState>) -> Result<Vec<ClaudeProcess>, String> {
    // Snapshot shared state under the lock, then release before spawning blocking work
    let tracked_panes: HashSet<String> = {
        let statuses = state.job_status.lock().unwrap();
        statuses
            .iter()
            .filter(|(name, _)| !name.starts_with("agent"))
            .filter_map(|(_, s)| match s {
                JobStatus::Running { pane_id: Some(pid), .. } => Some(pid.clone()),
                _ => None,
            })
            .collect()
    };

    let live_viewer_panes: HashSet<String> = {
        state.pty_manager.lock().unwrap().active_pane_ids()
    };

    let match_entries: Vec<(String, String, String)> = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .filter_map(|job| {
                if let Some(ref fp) = job.folder_path {
                    let root = fp.as_str();
                    Some((root.to_string(), job.group.clone(), job.name.clone()))
                } else if let Some(ref wd) = job.work_dir {
                    Some((wd.clone(), job.group.clone(), job.name.clone()))
                } else {
                    None
                }
            })
            .collect()
    };

    // Run all subprocess-heavy work off the async runtime
    tokio::task::spawn_blocking(move || {
        detect_claude_processes_blocking(tracked_panes, live_viewer_panes, match_entries)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?
}

fn detect_claude_processes_blocking(
    tracked_panes: HashSet<String>,
    live_viewer_panes: HashSet<String>,
    match_entries: Vec<(String, String, String)>,
) -> Result<Vec<ClaudeProcess>, String> {
    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}\t#{window_name}\t#{pane_pid}",
        ])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            if stderr.contains("no server running") || stderr.contains("no sessions") {
                return Ok(vec![]);
            }
            return Err(format!("tmux error: {}", stderr.trim()));
        }
        Err(e) => return Err(format!("Failed to run tmux: {}", e)),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut seen_panes = HashSet::new();
    let mut results = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(6, '\t').collect();
        if parts.len() < 6 {
            continue;
        }

        let pane_id = parts[0];
        let command = parts[1];
        let cwd = parts[2];
        let session = parts[3];
        let window = parts[4];
        let pane_pid = parts[5];

        if !is_semver(command) {
            continue;
        }

        if !seen_panes.insert(pane_id.to_string()) {
            continue;
        }

        if tracked_panes.contains(pane_id) {
            continue;
        }

        // Match against configured jobs: prefer exact CWD match only.
        // Prefix matching (starts_with) is too greedy - a job at /automation
        // would incorrectly claim processes in /automation/business/seo-optimise.
        let mut matched_group = None;
        for (root, group, _name) in &match_entries {
            if cwd == root {
                matched_group = Some(group.clone());
                break;
            }
        }

        let log_lines = if live_viewer_panes.contains(pane_id) {
            String::new()
        } else {
            crate::tmux::capture_pane(session, pane_id, 5)
                .unwrap_or_default()
                .trim()
                .to_string()
        };

        let session_info = crate::claude_session::resolve_session_info(pane_pid);

        results.push(ClaudeProcess {
            pane_id: pane_id.to_string(),
            cwd: cwd.to_string(),
            version: command.to_string(),
            process_type: detect_process_type(pane_pid),
            tmux_session: session.to_string(),
            window_name: window.to_string(),
            matched_group,
            matched_job: None,
            log_lines,
            first_query: session_info.first_query,
            last_query: session_info.last_query,
            session_started_at: session_info.session_started_at,
        });
    }

    Ok(results)
}

#[tauri::command]
pub fn focus_detected_process(tmux_session: String, window_name: String) -> Result<(), String> {
    if !crate::tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }
    crate::tmux::focus_window(&tmux_session, &window_name)
}

#[tauri::command]
pub fn get_detected_process_logs(tmux_session: String, pane_id: String) -> Result<String, String> {
    crate::tmux::capture_pane(&tmux_session, &pane_id, 200)
}

#[tauri::command]
pub fn send_detected_process_input(pane_id: String, text: String) -> Result<(), String> {
    crate::tmux::send_keys_to_tui_pane(&pane_id, &text)
}

#[tauri::command]
pub fn get_active_questions(state: State<AppState>) -> Vec<clawtab_protocol::ClaudeQuestion> {
    let yes_panes = state.auto_yes_panes.lock().unwrap();
    state.active_questions.lock().unwrap()
        .iter()
        .filter(|q| !yes_panes.contains(&q.pane_id))
        .cloned()
        .collect()
}

#[tauri::command]
pub fn get_auto_yes_panes(state: State<AppState>) -> Vec<String> {
    state.auto_yes_panes.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn set_auto_yes_panes(state: State<AppState>, pane_ids: Vec<String>) {
    let pane_set: HashSet<String> = pane_ids.iter().cloned().collect();
    *state.auto_yes_panes.lock().unwrap() = pane_set;

    // Push to relay for cross-device sync
    if let Ok(guard) = state.relay.lock() {
        if let Some(handle) = guard.as_ref() {
            handle.send_message(&DesktopMessage::AutoYesPanes {
                pane_ids,
            });
        }
    }
}

#[tauri::command]
pub fn sigint_detected_process(pane_id: String) -> Result<(), String> {
    crate::tmux::send_sigint_to_pane(&pane_id)?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    crate::tmux::send_sigint_to_pane(&pane_id)
}

#[tauri::command]
pub fn stop_detected_process(pane_id: String) -> Result<(), String> {
    crate::tmux::kill_pane(&pane_id)
}
