use base64::Engine;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// A pane viewer that attaches a hidden control-mode tmux client to a linked
/// session, zooms the target pane, and sizes the client to match the xterm.js
/// viewport.  The real terminal sees dots where the pane shrank, exactly like
/// opening a second smaller terminal.  On destroy the control client is killed
/// and the original terminal regains full sizing.
struct PaneViewer {
    pane_id: String,
    linked_session: String,
    stop: Arc<Mutex<bool>>,
    control_client: Option<Child>,
}

pub struct PtyManager {
    sessions: HashMap<String, PaneViewer>,
}

/// Find the tmux window id that contains `pane_id`.
fn window_of_pane(pane_id: &str) -> Option<String> {
    let out = Command::new("tmux")
        .args(["display-message", "-t", pane_id, "-p", "#{window_id}"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Find the tmux session that owns `pane_id`.
fn session_of_pane(pane_id: &str) -> Option<String> {
    let out = Command::new("tmux")
        .args(["display-message", "-t", pane_id, "-p", "#{session_name}"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn spawn(
        &mut self,
        pane_id: &str,
        _tmux_session: &str,
        cols: u16,
        rows: u16,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        if self.sessions.contains_key(pane_id) {
            return Err(format!("Viewer already exists for pane {}", pane_id));
        }

        let stop = Arc::new(Mutex::new(false));
        let pane_id_owned = pane_id.to_string();
        let event_key = pane_id.replace('%', "p");

        // Find the real session that owns this pane
        let real_session = session_of_pane(pane_id)
            .ok_or_else(|| format!("Cannot find session for pane {}", pane_id))?;

        let window_id = window_of_pane(pane_id)
            .ok_or_else(|| format!("Cannot find window for pane {}", pane_id))?;

        // Create a linked session (grouped with the real one)
        let linked = format!("clawtab-view-{}", event_key);

        // Kill any stale linked session from a previous run
        let _ = Command::new("tmux")
            .args(["kill-session", "-t", &linked])
            .output();

        // Create linked session targeting the window that contains our pane
        let new_sess = Command::new("tmux")
            .args([
                "new-session",
                "-d",       // detached (no terminal needed yet)
                "-s", &linked,
                "-t", &real_session,  // grouped / linked
            ])
            .output()
            .map_err(|e| format!("new-session failed: {}", e))?;

        if !new_sess.status.success() {
            let stderr = String::from_utf8_lossy(&new_sess.stderr);
            return Err(format!("new-session: {}", stderr.trim()));
        }

        // Switch the linked session to the correct window and zoom the pane
        let _ = Command::new("tmux")
            .args(["select-window", "-t", &format!("{}:{}", linked, window_id)])
            .output();

        let _ = Command::new("tmux")
            .args(["select-pane", "-t", &format!("{}:{}.{}", linked, window_id, pane_id_owned)])
            .output();

        // Zoom the pane so it fills the entire linked session window
        let _ = Command::new("tmux")
            .args(["resize-pane", "-Z", "-t", &format!("{}:{}.{}", linked, window_id, pane_id_owned)])
            .output();

        // Attach a control-mode client to the linked session.
        // -CC = control mode without echo.  The client's size determines the
        // pane dimensions visible through this session.
        let w = if cols > 0 { cols } else { 80 };
        let h = if rows > 0 { rows } else { 24 };

        let mut control = Command::new("tmux")
            .args([
                "attach-session",
                "-t", &linked,
                "-x", &w.to_string(),
                "-y", &h.to_string(),
                "-CC",  // control mode, no echo
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("control attach failed: {}", e))?;

        // Give tmux a moment to attach and resize
        thread::sleep(std::time::Duration::from_millis(150));

        // Now capture the pane at the new size
        let initial = Command::new("tmux")
            .args([
                "capture-pane",
                "-p",    // print to stdout
                "-e",    // include escape sequences (colors)
                "-S", "-", // from start of scrollback
                "-t", &pane_id_owned,
            ])
            .output()
            .map_err(|e| format!("Failed initial capture: {}", e))?;

        if initial.status.success() && !initial.stdout.is_empty() {
            let encoded =
                base64::engine::general_purpose::STANDARD.encode(&initial.stdout);
            let _ = app_handle.emit(&format!("pty-output-{}", event_key), encoded);
        }

        // Read the control client's stdout for pane output.
        // In control mode, tmux sends %output lines with pane content.
        let stdout = control.stdout.take();
        let stop_clone = Arc::clone(&stop);
        let pipe_event_key = event_key.clone();

        if let Some(stdout) = stdout {
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if *stop_clone.lock().unwrap() {
                        break;
                    }
                    let line = match line {
                        Ok(l) => l,
                        Err(_) => break,
                    };
                    // Control mode output format: %output {pane_id} {base64-or-raw data}
                    // We look for %output lines for our pane
                    if let Some(rest) = line.strip_prefix("%output ") {
                        // Format: %pane_id encoded_data
                        if let Some((_pane, data)) = rest.split_once(' ') {
                            // Data from control mode is raw (not base64)
                            let encoded =
                                base64::engine::general_purpose::STANDARD.encode(data.as_bytes());
                            let _ = app_handle
                                .emit(&format!("pty-output-{}", pipe_event_key), encoded);
                        }
                    }
                }
            });
        }

        self.sessions.insert(
            pane_id.to_string(),
            PaneViewer {
                pane_id: pane_id.to_string(),
                linked_session: linked,
                stop,
                control_client: Some(control),
            },
        );

        Ok(())
    }

    pub fn write(&mut self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let _session = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        let text = String::from_utf8_lossy(data);

        // Map xterm.js key sequences to tmux key names
        let tmux_key = match text.as_ref() {
            "\r" => Some("Enter"),
            "\x7f" => Some("BSpace"),
            "\x1b[A" => Some("Up"),
            "\x1b[B" => Some("Down"),
            "\x1b[C" => Some("Right"),
            "\x1b[D" => Some("Left"),
            "\x1b[H" => Some("Home"),
            "\x1b[F" => Some("End"),
            "\x1b[3~" => Some("DC"),     // Delete
            "\x1b[5~" => Some("PageUp"),
            "\x1b[6~" => Some("PageDown"),
            "\x1b" => Some("Escape"),
            "\t" => Some("Tab"),
            "\x01" => Some("C-a"),
            "\x02" => Some("C-b"),
            "\x03" => Some("C-c"),
            "\x04" => Some("C-d"),
            "\x05" => Some("C-e"),
            "\x06" => Some("C-f"),
            "\x0b" => Some("C-k"),
            "\x0c" => Some("C-l"),
            "\x0e" => Some("C-n"),
            "\x10" => Some("C-p"),
            "\x12" => Some("C-r"),
            "\x15" => Some("C-u"),
            "\x17" => Some("C-w"),
            "\x1a" => Some("C-z"),
            _ => None,
        };

        let output = if let Some(key) = tmux_key {
            Command::new("tmux")
                .args(["send-keys", "-t", pane_id, key])
                .output()
        } else {
            Command::new("tmux")
                .args(["send-keys", "-t", pane_id, "-l", &text])
                .output()
        };

        let output = output.map_err(|e| format!("Failed to send keys: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("send-keys failed: {}", stderr.trim()));
        }

        Ok(())
    }

    pub fn resize(&mut self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        if cols > 0 && rows > 0 {
            // Resize the control client, which changes the linked session's
            // view size and thus the pane dimensions.
            let _ = Command::new("tmux")
                .args([
                    "resize-window",
                    "-t", &session.linked_session,
                    "-x", &cols.to_string(),
                    "-y", &rows.to_string(),
                ])
                .output();
        }
        Ok(())
    }

    pub fn destroy(&mut self, pane_id: &str) -> Result<(), String> {
        if let Some(mut session) = self.sessions.remove(pane_id) {
            // Signal the reader thread to stop
            *session.stop.lock().unwrap() = true;

            // Kill the control-mode client process
            if let Some(ref mut child) = session.control_client {
                let _ = child.kill();
                let _ = child.wait();
            }

            // Kill the linked session - this removes the extra client
            // and the real terminal regains full sizing
            let _ = Command::new("tmux")
                .args(["kill-session", "-t", &session.linked_session])
                .output();
        }
        Ok(())
    }

    pub fn destroy_all(&mut self) {
        let pane_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for pane_id in pane_ids {
            let _ = self.destroy(&pane_id);
        }
    }
}

pub type SharedPtyManager = Arc<Mutex<PtyManager>>;
