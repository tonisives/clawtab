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
    pub tmux_session: String,
    pub window_name: String,
    pub matched_group: Option<String>,
    pub matched_job: Option<String>,
    pub log_lines: String,
}

fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

#[tauri::command]
pub fn detect_claude_processes(state: State<AppState>) -> Result<Vec<ClaudeProcess>, String> {
    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{session_name}\t#{window_name}",
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

    // Collect tracked pane_ids from job_status Running entries.
    // Exclude the "agent" job so its pane appears as a detected process
    // (AgentSection needs the ClaudeProcess to render the process card).
    let tracked_panes: HashSet<String> = {
        let statuses = state.job_status.lock().unwrap();
        statuses
            .iter()
            .filter(|(name, _)| name.as_str() != "agent")
            .filter_map(|(_, s)| match s {
                JobStatus::Running { pane_id: Some(pid), .. } => Some(pid.clone()),
                _ => None,
            })
            .collect()
    };

    // Build matching table from configured jobs: (project_root, group, job_name)
    let match_entries: Vec<(String, String, String)> = {
        let config = state.jobs_config.lock().unwrap();
        config
            .jobs
            .iter()
            .filter_map(|job| {
                if let Some(ref fp) = job.folder_path {
                    // Strip trailing /.cwt to get project root
                    let root = fp.strip_suffix("/.cwt").unwrap_or(fp);
                    Some((root.to_string(), job.group.clone(), job.name.clone()))
                } else if let Some(ref wd) = job.work_dir {
                    Some((wd.clone(), job.group.clone(), job.name.clone()))
                } else {
                    None
                }
            })
            .collect()
    };

    let mut seen_panes = HashSet::new();
    let mut results = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() < 5 {
            continue;
        }

        let pane_id = parts[0];
        let command = parts[1];
        let cwd = parts[2];
        let session = parts[3];
        let window = parts[4];

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
        let matched_job = None;
        for (root, group, _name) in &match_entries {
            if cwd == root {
                matched_group = Some(group.clone());
                break;
            }
        }

        let log_lines = crate::tmux::capture_pane(session, pane_id, 5)
            .unwrap_or_default()
            .trim()
            .to_string();

        results.push(ClaudeProcess {
            pane_id: pane_id.to_string(),
            cwd: cwd.to_string(),
            version: command.to_string(),
            tmux_session: session.to_string(),
            window_name: window.to_string(),
            matched_group,
            matched_job,
            log_lines,
        });
    }

    Ok(results)
}

#[tauri::command]
pub fn focus_detected_process(tmux_session: String, window_name: String) -> Result<(), String> {
    if !crate::tmux::is_available() {
        return Err("tmux is not installed".to_string());
    }
    crate::terminal::open_tmux_in_terminal(&tmux_session, &window_name)
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
    state.active_questions.lock().unwrap().clone()
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
pub fn stop_detected_process(pane_id: String) -> Result<(), String> {
    crate::tmux::kill_pane(&pane_id)
}
