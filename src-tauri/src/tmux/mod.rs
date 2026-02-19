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

pub fn create_window(session: &str, name: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["new-window", "-t", session, "-n", name])
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
