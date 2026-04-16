use crate::debug_spawn;
use serde::Serialize;
use std::process::{Command, Output};

#[derive(Debug, Clone, Serialize)]
pub struct TmuxWindow {
    pub name: String,
    pub index: u32,
    pub active: bool,
}

/// Run `tmux <args>` with telemetry. Mirrors `Command::new("tmux").args(args).output()`.
fn run(args: &[&str], callsite: &'static str) -> std::io::Result<Output> {
    debug_spawn::run_logged("tmux", args, callsite)
}

pub fn is_available() -> bool {
    run(&["-V"], "tmux::is_available")
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn list_sessions() -> Result<Vec<String>, String> {
    let output = run(
        &["list-sessions", "-F", "#{session_name}"],
        "tmux::list_sessions",
    )
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
    let output = run(
        &[
            "list-windows",
            "-t",
            session,
            "-F",
            "#{window_index}:#{window_name}:#{window_active}",
        ],
        "tmux::list_windows",
    )
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
    run(&["has-session", "-t", session], "tmux::session_exists")
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// True for ephemeral `clawtab-*-view-N` sessions created by the PTY viewer.
fn is_view_session(name: &str) -> bool {
    name.starts_with("clawtab-") && name.contains("-view-")
}

/// Resolve the real owning (non-view) tmux session for a pane.
///
/// `display-message -t %pane_id -p '#{session_name}'` is unreliable when the
/// pane's window is shared across a session group: tmux picks whichever group
/// member it likes, often returning an ephemeral `clawtab-*-view-N` session.
/// Instead, look up the pane's window_id, then list all windows to find the
/// non-view session that owns that window.
pub fn resolve_real_session_for_pane(pane_id: &str) -> Result<String, String> {
    let window_id = run(
        &["display-message", "-t", pane_id, "-p", "#{window_id}"],
        "tmux::resolve_real_session_for_pane::window_id",
    )
    .map_err(|e| format!("Failed to resolve window for pane: {}", e))?;
    if !window_id.status.success() {
        return Err(format!(
            "tmux error: {}",
            String::from_utf8_lossy(&window_id.stderr).trim()
        ));
    }
    let window_id = String::from_utf8_lossy(&window_id.stdout).trim().to_string();

    let output = run(
        &["list-windows", "-a", "-F", "#{session_name}\t#{window_id}"],
        "tmux::resolve_real_session_for_pane::list_windows",
    )
    .map_err(|e| format!("Failed to list windows: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "tmux error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let mut fallback: Option<String> = None;
    for line in raw.lines() {
        let mut parts = line.splitn(2, '\t');
        let session = parts.next().unwrap_or("");
        let wid = parts.next().unwrap_or("");
        if wid != window_id {
            continue;
        }
        if !is_view_session(session) {
            return Ok(session.to_string());
        }
        if fallback.is_none() {
            fallback = Some(session.to_string());
        }
    }
    fallback.ok_or_else(|| format!("no session owns window {}", window_id))
}

pub fn create_session(session: &str) -> Result<(), String> {
    let output = run(
        &["new-session", "-d", "-s", session],
        "tmux::create_session",
    )
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

pub fn create_window_with_cwd(
    session: &str,
    name: &str,
    cwd: Option<&str>,
    env_vars: &[(String, String)],
) -> Result<String, String> {
    let mut args = vec![
        "new-window",
        "-a",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        session,
        "-n",
        name,
    ];
    if let Some(cwd) = cwd {
        args.push("-c");
        args.push(cwd);
    }
    let env_pairs: Vec<String> = env_vars
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect();
    for pair in &env_pairs {
        args.push("-e");
        args.push(pair);
    }

    let output = run(&args, "tmux::create_window_with_cwd")
        .map_err(|e| format!("Failed to create tmux window: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Set the title of a tmux pane (used to tag panes with job slugs).
pub fn set_pane_title(pane_id: &str, title: &str) -> Result<(), String> {
    let output = run(
        &["select-pane", "-t", pane_id, "-T", title],
        "tmux::set_pane_title",
    )
    .map_err(|e| format!("Failed to set pane title: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

/// Send keys to a specific pane by its ID (e.g. "%42").
/// Pane IDs starting with '%' are global tmux targets and used directly.
pub fn send_keys_to_pane(_session: &str, pane_id: &str, keys: &str) -> Result<(), String> {
    let output = run(
        &["send-keys", "-t", pane_id, keys, "Enter"],
        "tmux::send_keys_to_pane",
    )
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
    let output = run(
        &["send-keys", "-t", pane_id, "-l", text],
        "tmux::send_keys_to_tui_pane::text",
    )
    .map_err(|e| format!("Failed to send text to pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    // Press Enter to submit
    let output = run(
        &["send-keys", "-t", pane_id, "Enter"],
        "tmux::send_keys_to_tui_pane::enter",
    )
    .map_err(|e| format!("Failed to send Enter to pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

/// Send a keystroke to select a "Type something" option, then type freetext and press Enter.
/// The keystroke is sent without -l so it acts as navigation, then the freetext is sent literally.
pub fn send_keys_to_tui_pane_freetext(
    pane_id: &str,
    keystroke: &str,
    freetext: &str,
) -> Result<(), String> {
    // Send the option number as a keystroke (navigates to the option)
    let output = run(
        &["send-keys", "-t", pane_id, keystroke],
        "tmux::send_keys_to_tui_pane_freetext::keystroke",
    )
    .map_err(|e| format!("Failed to send keystroke to pane: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    // Type the freetext literally
    let output = run(
        &["send-keys", "-t", pane_id, "-l", freetext],
        "tmux::send_keys_to_tui_pane_freetext::text",
    )
    .map_err(|e| format!("Failed to send freetext to pane: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    // Press Enter to submit
    let output = run(
        &["send-keys", "-t", pane_id, "Enter"],
        "tmux::send_keys_to_tui_pane_freetext::enter",
    )
    .map_err(|e| format!("Failed to send Enter to pane: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(())
}

/// Capture the full visible area of a pane with ANSI escape sequences preserved.
/// Returns (text, pane_height). Uses `-J` to avoid trailing whitespace trimming
/// so line count matches pane height exactly.
pub fn capture_pane_visible(pane_id: &str) -> Result<(String, u16), String> {
    let dim_output = run(
        &["display", "-t", pane_id, "-p", "#{pane_height}"],
        "tmux::capture_pane_visible::height",
    )
    .map_err(|e| format!("Failed to get pane height: {}", e))?;
    if !dim_output.status.success() {
        let stderr = String::from_utf8_lossy(&dim_output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    let height: u16 = String::from_utf8_lossy(&dim_output.stdout)
        .trim()
        .parse()
        .map_err(|_| "Failed to parse pane height".to_string())?;
    let end = format!("{}", height.saturating_sub(1));
    let output = run(
        &[
            "capture-pane",
            "-t",
            pane_id,
            "-p",
            "-e",
            "-J",
            "-S",
            "0",
            "-E",
            &end,
        ],
        "tmux::capture_pane_visible",
    )
    .map_err(|e| format!("Failed to capture pane: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok((String::from_utf8_lossy(&output.stdout).to_string(), height))
}

/// Send a mouse click (press + release) to a pane at the given column and row.
/// Coordinates are 0-indexed from the top-left of the pane.
/// Uses SGR mouse encoding which modern TUI apps (opencode, etc.) understand.
pub fn send_mouse_click_to_pane(pane_id: &str, col: u16, row: u16) -> Result<(), String> {
    // SGR mouse uses 1-based coordinates
    let x = col + 1;
    let y = row + 1;
    // Press: ESC [ < 0 ; X ; Y M
    let press = format!("\x1b[<0;{};{}M", x, y);
    // Release: ESC [ < 0 ; X ; Y m
    let release = format!("\x1b[<0;{};{}m", x, y);

    let output = run(
        &["send-keys", "-t", pane_id, "-l", &press],
        "tmux::send_mouse_click::press",
    )
    .map_err(|e| format!("Failed to send mouse press: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    let output = run(
        &["send-keys", "-t", pane_id, "-l", &release],
        "tmux::send_mouse_click::release",
    )
    .map_err(|e| format!("Failed to send mouse release: {}", e))?;
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
    let output = run(
        &["capture-pane", "-t", pane_id, "-p", "-e", "-S", &start],
        "tmux::capture_pane",
    )
    .map_err(|e| format!("Failed to capture pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Check if a tmux pane exists (hasn't been killed/closed).
pub fn pane_exists(pane_id: &str) -> bool {
    let output = run(
        &["list-panes", "-t", pane_id, "-F", "#{pane_id}"],
        "tmux::pane_exists",
    );
    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.lines().any(|line| line.trim() == pane_id)
        }
        _ => false,
    }
}

/// Check if a specific pane has an active (non-shell) process running.
/// Pane IDs starting with '%' are global tmux targets and used directly.
pub fn is_pane_busy(_session: &str, pane_id: &str) -> bool {
    let output = run(
        &[
            "list-panes",
            "-t",
            pane_id,
            "-F",
            "#{pane_id}:#{pane_current_command}",
        ],
        "tmux::is_pane_busy",
    );

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.lines().any(|line| {
                if let Some((id, cmd)) = line.split_once(':') {
                    id == pane_id
                        && !cmd.trim().is_empty()
                        && !matches!(cmd.trim(), "bash" | "zsh" | "fish" | "sh" | "dash")
                } else {
                    false
                }
            })
        }
        _ => false,
    }
}

/// Capture the entire scrollback from a pane.
pub fn capture_pane_full(pane_id: &str) -> Result<String, String> {
    let output = run(
        &["capture-pane", "-t", pane_id, "-p", "-e", "-S", "-"],
        "tmux::capture_pane_full",
    )
    .map_err(|e| format!("Failed to capture pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Send C-c (SIGINT) to a specific pane by its ID.
pub fn send_sigint_to_pane(pane_id: &str) -> Result<(), String> {
    let output = run(
        &["send-keys", "-t", pane_id, "C-c"],
        "tmux::send_sigint_to_pane",
    )
    .map_err(|e| format!("Failed to send C-c to pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

/// Kill a specific pane by its ID (e.g. "%42").
pub fn kill_pane(pane_id: &str) -> Result<(), String> {
    let output = run(&["kill-pane", "-t", pane_id], "tmux::kill_pane")
        .map_err(|e| format!("Failed to kill pane: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

/// Kill a tmux window by session and window name.
pub fn kill_window(session: &str, window: &str) -> Result<(), String> {
    let target = format!("{}:{}", session, window);
    let output = run(&["kill-window", "-t", &target], "tmux::kill_window")
        .map_err(|e| format!("Failed to kill window: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tmux error: {}", stderr.trim()));
    }
    Ok(())
}

pub fn focus_window(session: &str, window: &str) -> Result<(), String> {
    let target = format!("{}:{}", session, window);
    let output = run(&["select-window", "-t", &target], "tmux::focus_window")
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
    let output = run(
        &[
            "display-message",
            "-t",
            pane_id,
            "-p",
            "#{pane_current_path}",
        ],
        "tmux::get_pane_path",
    )
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

/// Find which terminal app has the tmux client for a session and bring it to front.
fn activate_terminal_for_session(session: &str) -> Result<(), String> {
    // Get the TTY of the client attached to this session
    let output = run(
        &["list-clients", "-t", session, "-F", "#{client_tty}"],
        "tmux::activate_terminal_for_session",
    )
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
