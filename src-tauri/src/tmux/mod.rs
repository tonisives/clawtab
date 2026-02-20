use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct TmuxWindow {
    pub name: String,
    pub index: u32,
    pub active: bool,
}

pub fn is_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn list_sessions() -> Result<Vec<String>, String> {
    let output = Command::new("tmux")
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
        .map_err(|e| format!("Failed to run tmux: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "no server running" is not an error, just means no sessions
        if stderr.contains("no server running") || stderr.contains("no sessions") {
            return Ok(vec![]);
        }
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

pub fn list_windows(session: &str) -> Result<Vec<TmuxWindow>, String> {
    let output = Command::new("tmux")
        .args([
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_index}:#{window_name}:#{window_active}",
        ])
        .output()
        .map_err(|e| format!("Failed to list tmux windows: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, ':').collect();
            if parts.len() >= 3 {
                Some(TmuxWindow {
                    index: parts[0].parse().unwrap_or(0),
                    name: parts[1].to_string(),
                    active: parts[2] == "1",
                })
            } else {
                None
            }
        })
        .collect())
}

pub fn session_exists(session: &str) -> bool {
    Command::new("tmux")
        .args(["has-session", "-t", session])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn create_session(session: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["new-session", "-d", "-s", session])
        .output()
        .map_err(|e| format!("Failed to create tmux session: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

pub fn window_exists(session: &str, window_name: &str) -> bool {
    list_windows(session)
        .map(|windows| windows.iter().any(|w| w.name == window_name))
        .unwrap_or(false)
}

pub fn create_window(session: &str, name: &str, env_vars: &[(String, String)]) -> Result<(), String> {
    let mut args = vec!["new-window", "-t", session, "-n", name];
    let env_pairs: Vec<String> = env_vars.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
    for pair in &env_pairs {
        args.push("-e");
        args.push(pair);
    }

    let output = Command::new("tmux")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to create tmux window: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

pub fn send_keys(session: &str, window: &str, keys: &str) -> Result<(), String> {
    let target = format!("{}:{}", session, window);
    let output = Command::new("tmux")
        .args(["send-keys", "-t", &target, keys, "Enter"])
        .output()
        .map_err(|e| format!("Failed to send keys: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

/// Check if a tmux window has an active (non-shell) process running.
/// Returns true if the pane's current command is something other than a shell.
pub fn is_window_busy(session: &str, window: &str) -> bool {
    let target = format!("{}:{}", session, window);
    let output = Command::new("tmux")
        .args(["list-panes", "-t", &target, "-F", "#{pane_current_command}"])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.lines().any(|cmd| {
                let cmd = cmd.trim();
                !cmd.is_empty() && !matches!(cmd, "bash" | "zsh" | "fish" | "sh" | "dash")
            })
        }
        _ => false,
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct PaneInfo {
    pub pane_id: String,
    pub current_command: String,
    pub active: bool,
}

/// Split a window to create a new pane, returning the new pane ID (e.g. "%42").
pub fn split_pane(session: &str, window: &str, env_vars: &[(String, String)]) -> Result<String, String> {
    let target = format!("{}:{}", session, window);
    let mut args = vec![
        "split-window".to_string(),
        "-t".to_string(),
        target,
        "-P".to_string(),
        "-F".to_string(),
        "#{pane_id}".to_string(),
    ];
    for (k, v) in env_vars {
        args.push("-e".to_string());
        args.push(format!("{}={}", k, v));
    }

    let output = Command::new("tmux")
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to split pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Send keys to a specific pane by its ID (e.g. "%42").
/// Pane IDs starting with '%' are global tmux targets and used directly.
pub fn send_keys_to_pane(_session: &str, pane_id: &str, keys: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["send-keys", "-t", pane_id, keys, "Enter"])
        .output()
        .map_err(|e| format!("Failed to send keys to pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

/// Capture the last N lines from a specific pane.
/// Pane IDs starting with '%' are global tmux targets and used directly.
pub fn capture_pane(_session: &str, pane_id: &str, lines: u32) -> Result<String, String> {
    let start = format!("-{}", lines);
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-t",
            pane_id,
            "-p",
            "-S",
            &start,
        ])
        .output()
        .map_err(|e| format!("Failed to capture pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Check if a specific pane has an active (non-shell) process running.
/// Pane IDs starting with '%' are global tmux targets and used directly.
pub fn is_pane_busy(_session: &str, pane_id: &str) -> bool {
    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-t",
            pane_id,
            "-F",
            "#{pane_id}:#{pane_current_command}",
        ])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.lines().any(|line| {
                if let Some((id, cmd)) = line.split_once(':') {
                    id == pane_id
                        && !cmd.trim().is_empty()
                        && !matches!(
                            cmd.trim(),
                            "bash" | "zsh" | "fish" | "sh" | "dash"
                        )
                } else {
                    false
                }
            })
        }
        _ => false,
    }
}

/// List all panes in a window.
#[allow(dead_code)]
pub fn list_panes(session: &str, window: &str) -> Result<Vec<PaneInfo>, String> {
    let target = format!("{}:{}", session, window);
    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-t",
            &target,
            "-F",
            "#{pane_id}:#{pane_current_command}:#{pane_active}",
        ])
        .output()
        .map_err(|e| format!("Failed to list panes: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, ':').collect();
            if parts.len() >= 3 {
                Some(PaneInfo {
                    pane_id: parts[0].to_string(),
                    current_command: parts[1].to_string(),
                    active: parts[2] == "1",
                })
            } else {
                None
            }
        })
        .collect())
}

/// Get the active pane ID of a window (e.g. "%42").
pub fn get_window_pane_id(session: &str, window: &str) -> Result<String, String> {
    let target = format!("{}:{}", session, window);
    let output = Command::new("tmux")
        .args(["list-panes", "-t", &target, "-F", "#{pane_id}"])
        .output()
        .map_err(|e| format!("Failed to list panes: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .last()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "No pane found".to_string())
}

/// Capture the entire scrollback from a pane.
pub fn capture_pane_full(pane_id: &str) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(["capture-pane", "-t", pane_id, "-p", "-S", "-"])
        .output()
        .map_err(|e| format!("Failed to capture pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn focus_window(session: &str, window: &str) -> Result<(), String> {
    let target = format!("{}:{}", session, window);
    // Select the window within the session
    let output = Command::new("tmux")
        .args(["select-window", "-t", &target])
        .output()
        .map_err(|e| format!("Failed to focus window: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}
