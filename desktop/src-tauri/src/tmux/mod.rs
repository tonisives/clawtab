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

/// Set the title of a tmux pane (used to tag panes with job slugs).
pub fn set_pane_title(pane_id: &str, title: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["select-pane", "-t", pane_id, "-T", title])
        .output()
        .map_err(|e| format!("Failed to set pane title: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
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

/// Send text to a TUI pane (like Claude Code) that uses vim-style input.
/// Types the text literally, then presses Enter to submit.
pub fn send_keys_to_tui_pane(pane_id: &str, text: &str) -> Result<(), String> {
    // Send text literally (prevents tmux from interpreting special keys)
    let output = Command::new("tmux")
        .args(["send-keys", "-t", pane_id, "-l", text])
        .output()
        .map_err(|e| format!("Failed to send text to pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    // Press Enter to submit
    let output = Command::new("tmux")
        .args(["send-keys", "-t", pane_id, "Enter"])
        .output()
        .map_err(|e| format!("Failed to send Enter to pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

/// Send a keystroke to select a "Type something" option, then type freetext and press Enter.
/// The keystroke is sent without -l so it acts as navigation, then the freetext is sent literally.
pub fn send_keys_to_tui_pane_freetext(pane_id: &str, keystroke: &str, freetext: &str) -> Result<(), String> {
    // Send the option number as a keystroke (navigates to the option)
    let output = Command::new("tmux")
        .args(["send-keys", "-t", pane_id, keystroke])
        .output()
        .map_err(|e| format!("Failed to send keystroke to pane: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    // Type the freetext literally
    let output = Command::new("tmux")
        .args(["send-keys", "-t", pane_id, "-l", freetext])
        .output()
        .map_err(|e| format!("Failed to send freetext to pane: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    // Press Enter to submit
    let output = Command::new("tmux")
        .args(["send-keys", "-t", pane_id, "Enter"])
        .output()
        .map_err(|e| format!("Failed to send Enter to pane: {}", e))?;
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
            "-e",
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

/// Check if a tmux pane exists (hasn't been killed/closed).
pub fn pane_exists(pane_id: &str) -> bool {
    Command::new("tmux")
        .args(["has-session", "-t", pane_id])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
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
        .args(["capture-pane", "-t", pane_id, "-p", "-e", "-S", "-"])
        .output()
        .map_err(|e| format!("Failed to capture pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Send C-c (SIGINT) to a specific pane by its ID.
pub fn send_sigint_to_pane(pane_id: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["send-keys", "-t", pane_id, "C-c"])
        .output()
        .map_err(|e| format!("Failed to send C-c to pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

/// Kill a specific pane by its ID (e.g. "%42").
pub fn kill_pane(pane_id: &str) -> Result<(), String> {
    let output = Command::new("tmux")
        .args(["kill-pane", "-t", pane_id])
        .output()
        .map_err(|e| format!("Failed to kill pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

pub fn focus_window(session: &str, window: &str) -> Result<(), String> {
    let target = format!("{}:{}", session, window);
    let output = Command::new("tmux")
        .args(["select-window", "-t", &target])
        .output()
        .map_err(|e| format!("Failed to focus window: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    // Activate the terminal window that has this tmux session attached
    let _ = activate_terminal_for_session(session);
    Ok(())
}

/// Get the working directory of a pane.
pub fn get_pane_path(pane_id: &str) -> Result<String, String> {
    let output = Command::new("tmux")
        .args(["display-message", "-t", pane_id, "-p", "#{pane_current_path}"])
        .output()
        .map_err(|e| format!("Failed to get pane path: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err("Pane has no working directory".to_string());
    }
    Ok(path)
}

/// Split a pane by its ID, returning the new pane ID.
pub fn split_pane_by_id(pane_id: &str, cwd: &str, env_vars: &[(String, String)]) -> Result<String, String> {
    let mut args = vec![
        "split-window".to_string(),
        "-v".to_string(),
        "-t".to_string(),
        pane_id.to_string(),
        "-c".to_string(),
        cwd.to_string(),
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

/// Find which terminal app has the tmux client for a session and bring it to front.
fn activate_terminal_for_session(session: &str) -> Result<(), String> {
    // Get the TTY of the client attached to this session
    let output = Command::new("tmux")
        .args([
            "list-clients",
            "-t",
            session,
            "-F",
            "#{client_tty}",
        ])
        .output()
        .map_err(|e| format!("Failed to list clients: {}", e))?;

    let tty = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .to_string();

    if tty.is_empty() {
        return Err("No client attached to session".to_string());
    }

    // Strip /dev/ prefix to get the tty name for ps
    let tty_short = tty.trim_start_matches("/dev/");

    // Find the tmux client process on this TTY, then walk up to find the terminal app
    let ps_output = Command::new("ps")
        .args(["-o", "pid,ppid,comm", "-t", tty_short])
        .output()
        .map_err(|e| format!("Failed to run ps: {}", e))?;

    let ps_str = String::from_utf8_lossy(&ps_output.stdout);

    // Find the shell process (parent of tmux client) and get its parent (the terminal app)
    let mut terminal_pid: Option<u32> = None;
    for line in ps_str.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[2].contains("tmux") {
            // tmux's parent is the shell, shell's parent is the terminal
            if let Ok(shell_pid) = parts[1].parse::<u32>() {
                // Get the shell's parent
                let parent_output = Command::new("ps")
                    .args(["-o", "ppid", "-p", &shell_pid.to_string()])
                    .output()
                    .ok();
                if let Some(out) = parent_output {
                    let s = String::from_utf8_lossy(&out.stdout);
                    if let Some(ppid_str) = s.lines().nth(1) {
                        terminal_pid = ppid_str.trim().parse().ok();
                    }
                }
            }
            break;
        }
    }

    let pid = terminal_pid.ok_or("Could not find terminal process")?;

    // Get the app name from the PID
    let app_output = Command::new("ps")
        .args(["-o", "comm", "-p", &pid.to_string()])
        .output()
        .map_err(|e| format!("Failed to get app name: {}", e))?;

    let comm = String::from_utf8_lossy(&app_output.stdout)
        .lines()
        .nth(1)
        .unwrap_or("")
        .trim()
        .to_string();

    // Extract the .app name from the path (e.g. /Applications/Alacritty.app/Contents/MacOS/alacritty)
    let app_name = if let Some(start) = comm.find("/Applications/") {
        let after = &comm[start + 14..];
        after.split(".app").next().unwrap_or(&comm).to_string()
    } else {
        // Fallback: use the binary name
        comm.rsplit('/').next().unwrap_or(&comm).to_string()
    };

    // Activate the app via osascript
    Command::new("osascript")
        .args([
            "-e",
            &format!(r#"tell application "{}" to activate"#, app_name),
        ])
        .output()
        .map_err(|e| format!("Failed to activate {}: {}", app_name, e))?;

    Ok(())
}
