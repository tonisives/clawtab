use std::process::Command;

#[derive(Debug, Clone, PartialEq)]
pub enum TerminalApp {
    Alacritty,
    Kitty,
    WezTerm,
    ITerm,
    Ghostty,
    TerminalApp,
}

/// Detect running terminal emulators via process list
pub fn detect_terminal() -> TerminalApp {
    let output = Command::new("ps")
        .args(["-eo", "comm"])
        .output()
        .ok();

    let procs = output
        .as_ref()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    // Check in preference order
    if procs.contains("ghostty") {
        TerminalApp::Ghostty
    } else if procs.contains("alacritty") {
        TerminalApp::Alacritty
    } else if procs.contains("kitty") {
        TerminalApp::Kitty
    } else if procs.contains("wezterm") {
        TerminalApp::WezTerm
    } else if procs.contains("iTerm") {
        TerminalApp::ITerm
    } else {
        TerminalApp::TerminalApp
    }
}

/// Open a terminal with an optional command to run
pub fn open_in_terminal(cmd: &str) -> Result<(), String> {
    let terminal = detect_terminal();

    match terminal {
        TerminalApp::Alacritty => {
            Command::new("alacritty")
                .args(["-e", "sh", "-c", cmd])
                .spawn()
                .map_err(|e| format!("Failed to open Alacritty: {}", e))?;
        }
        TerminalApp::Kitty => {
            Command::new("kitty")
                .args(["sh", "-c", cmd])
                .spawn()
                .map_err(|e| format!("Failed to open Kitty: {}", e))?;
        }
        TerminalApp::WezTerm => {
            Command::new("wezterm")
                .args(["start", "--", "sh", "-c", cmd])
                .spawn()
                .map_err(|e| format!("Failed to open WezTerm: {}", e))?;
        }
        TerminalApp::Ghostty => {
            Command::new("ghostty")
                .args(["-e", "sh", "-c", cmd])
                .spawn()
                .map_err(|e| format!("Failed to open Ghostty: {}", e))?;
        }
        TerminalApp::ITerm | TerminalApp::TerminalApp => {
            // Use osascript for macOS native terminals
            let app_name = if terminal == TerminalApp::ITerm {
                "iTerm"
            } else {
                "Terminal"
            };
            let script = format!(
                r#"tell application "{}" to do script "{}""#,
                app_name, cmd
            );
            Command::new("osascript")
                .args(["-e", &script])
                .spawn()
                .map_err(|e| format!("Failed to open {}: {}", app_name, e))?;
        }
    }

    Ok(())
}

/// Open a tmux session in the user's terminal, attaching to it
pub fn open_tmux_in_terminal(session: &str) -> Result<(), String> {
    let cmd = format!("tmux attach-session -t {}", session);
    open_in_terminal(&cmd)
}
