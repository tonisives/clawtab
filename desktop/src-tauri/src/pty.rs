use base64::Engine;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// A pane viewer that uses `tmux capture-pane` for reading and `tmux send-keys`
/// for writing. No grouped sessions, no PTY allocation, no focus stealing.
/// Resizes the real pane to match the xterm.js viewport and restores on destroy.
struct PaneViewer {
    pane_id: String,
    stop: Arc<Mutex<bool>>,
    original_width: u16,
    original_height: u16,
}

pub struct PtyManager {
    sessions: HashMap<String, PaneViewer>,
}

fn get_pane_size(pane_id: &str) -> Option<(u16, u16)> {
    let output = std::process::Command::new("tmux")
        .args([
            "display-message",
            "-t",
            pane_id,
            "-p",
            "#{pane_width} #{pane_height}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let parts: Vec<&str> = text.trim().split(' ').collect();
    if parts.len() == 2 {
        let w = parts[0].parse::<u16>().ok()?;
        let h = parts[1].parse::<u16>().ok()?;
        Some((w, h))
    } else {
        None
    }
}

fn resize_pane(pane_id: &str, cols: u16, rows: u16) {
    let _ = std::process::Command::new("tmux")
        .args([
            "resize-pane",
            "-t",
            pane_id,
            "-x",
            &cols.to_string(),
            "-y",
            &rows.to_string(),
        ])
        .output();
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
        let stop_clone = Arc::clone(&stop);
        let pane_id_owned = pane_id.to_string();
        let event_key = pane_id.replace('%', "p");

        // Save original pane size so we can restore it on destroy
        let (original_width, original_height) =
            get_pane_size(pane_id).unwrap_or((80, 24));

        // Resize the real tmux pane to match the xterm.js viewport
        if cols > 0 && rows > 0 {
            resize_pane(pane_id, cols, rows);
            // Small delay to let tmux + the app inside redraw at the new size
            thread::sleep(std::time::Duration::from_millis(100));
        }

        // Capture the full scrollback + visible content (now at the new size)
        let initial = std::process::Command::new("tmux")
            .args([
                "capture-pane",
                "-p",    // print to stdout
                "-e",    // include escape sequences (colors)
                "-S", "-", // from start of scrollback
                "-t",
                &pane_id_owned,
            ])
            .output()
            .map_err(|e| format!("Failed initial capture: {}", e))?;

        if !initial.status.success() {
            let stderr = String::from_utf8_lossy(&initial.stderr);
            return Err(format!("capture-pane failed: {}", stderr.trim()));
        }

        // Send initial content
        let initial_data = initial.stdout;
        if !initial_data.is_empty() {
            let encoded =
                base64::engine::general_purpose::STANDARD.encode(&initial_data);
            let _ = app_handle.emit(&format!("pty-output-{}", event_key), encoded);
        }

        // Use tmux pipe-pane to stream output to a temporary file, then tail it
        let pipe_event_key = event_key.clone();
        let pipe_pane_id = pane_id_owned.clone();
        let pipe_path = format!("/tmp/clawtab-pipe-{}", event_key);

        // Clean up any old pipe file
        let _ = std::fs::remove_file(&pipe_path);

        // Start pipe-pane: this streams the pane's output to our file
        let pipe_result = std::process::Command::new("tmux")
            .args([
                "pipe-pane",
                "-t",
                &pipe_pane_id,
                &format!("cat >> {}", pipe_path),
            ])
            .output()
            .map_err(|e| format!("Failed to start pipe-pane: {}", e))?;

        if !pipe_result.status.success() {
            let stderr = String::from_utf8_lossy(&pipe_result.stderr);
            return Err(format!("pipe-pane failed: {}", stderr.trim()));
        }

        // Spawn reader thread that tails the pipe file
        let pipe_path_clone = pipe_path.clone();
        thread::spawn(move || {
            use std::io::Read;

            // Wait for the file to be created
            let mut attempts = 0;
            while !std::path::Path::new(&pipe_path_clone).exists() {
                if *stop_clone.lock().unwrap() {
                    return;
                }
                thread::sleep(std::time::Duration::from_millis(50));
                attempts += 1;
                if attempts > 100 {
                    // File never appeared, but that's OK - pane might be idle
                    // Just poll until stopped
                    loop {
                        if *stop_clone.lock().unwrap() {
                            return;
                        }
                        thread::sleep(std::time::Duration::from_millis(100));
                        if std::path::Path::new(&pipe_path_clone).exists() {
                            break;
                        }
                    }
                    break;
                }
            }

            // Open and tail the file
            let mut file = match std::fs::File::open(&pipe_path_clone) {
                Ok(f) => f,
                Err(_) => {
                    // If we still can't open it, wait for it in a loop
                    loop {
                        if *stop_clone.lock().unwrap() {
                            return;
                        }
                        thread::sleep(std::time::Duration::from_millis(200));
                        match std::fs::File::open(&pipe_path_clone) {
                            Ok(f) => break f,
                            Err(_) => continue,
                        }
                    }
                }
            };

            let mut buf = [0u8; 8192];
            loop {
                if *stop_clone.lock().unwrap() {
                    break;
                }
                match file.read(&mut buf) {
                    Ok(0) => {
                        // No new data, sleep briefly
                        thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Ok(n) => {
                        let encoded =
                            base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ = app_handle
                            .emit(&format!("pty-output-{}", pipe_event_key), encoded);
                    }
                    Err(_) => {
                        thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }
        });

        self.sessions.insert(
            pane_id.to_string(),
            PaneViewer {
                pane_id: pane_id.to_string(),
                stop,
                original_width,
                original_height,
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
            std::process::Command::new("tmux")
                .args(["send-keys", "-t", pane_id, key])
                .output()
        } else {
            // Literal text
            std::process::Command::new("tmux")
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
        let _session = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        if cols > 0 && rows > 0 {
            resize_pane(pane_id, cols, rows);
        }
        Ok(())
    }

    pub fn destroy(&mut self, pane_id: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.remove(pane_id) {
            // Signal the reader thread to stop
            *session.stop.lock().unwrap() = true;

            // Stop pipe-pane
            let _ = std::process::Command::new("tmux")
                .args(["pipe-pane", "-t", &session.pane_id])
                .output();

            // Restore original pane size
            resize_pane(
                &session.pane_id,
                session.original_width,
                session.original_height,
            );

            // Clean up temp file
            let event_key = pane_id.replace('%', "p");
            let _ = std::fs::remove_file(format!("/tmp/clawtab-pipe-{}", event_key));
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
