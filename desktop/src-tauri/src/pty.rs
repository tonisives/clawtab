use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// Pane viewer using tmux control mode for live streaming.
/// A linked session with the target pane zoomed allows resizing
/// independently of other panes in the window.
struct PaneViewer {
    linked_session: String,
    window_id: String,
    stop: Arc<Mutex<bool>>,
}

/// Where PTY output bytes should be sent.
pub enum OutputSink {
    /// Emit as Tauri event (local desktop xterm.js)
    Tauri(AppHandle),
    /// Send via channel (relay forwarding to remote clients)
    Channel(std::sync::mpsc::Sender<(String, Vec<u8>)>),
}

/// Returned from spawn so the frontend knows the pane's native size.
pub struct SpawnResult {
    pub native_cols: u16,
    pub native_rows: u16,
}

pub struct PtyManager {
    sessions: HashMap<String, PaneViewer>,
}

fn tmux(args: &[&str]) -> Result<String, String> {
    let out = Command::new("tmux")
        .args(args)
        .output()
        .map_err(|e| format!("tmux {}: {}", args[0], e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("tmux {}: {}", args[0], stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Decode tmux control-mode octal escapes: \NNN -> byte value
fn decode_tmux_octal(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len()
            && bytes[i + 1].is_ascii_digit()
            && bytes[i + 2].is_ascii_digit()
            && bytes[i + 3].is_ascii_digit()
        {
            let val = (bytes[i + 1] - b'0') as u16 * 64
                + (bytes[i + 2] - b'0') as u16 * 8
                + (bytes[i + 3] - b'0') as u16;
            out.push(val as u8);
            i += 4;
        } else if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
            out.push(b'\\');
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// Create a linked session with the target pane zoomed so resize-window
/// controls that pane's dimensions exclusively.
fn create_linked_session(pane_id: &str, real_session: &str, window_id: &str) -> Result<String, String> {
    let event_key = pane_id.replace('%', "p");
    let linked = format!("clawtab-view-{}", event_key);

    let _ = tmux(&["kill-session", "-t", &linked]);
    tmux(&["new-session", "-d", "-s", &linked, "-t", real_session])?;
    let _ = tmux(&["set-option", "-s", "-t", &linked, "window-size", "manual"]);

    // Select the window and zoom the target pane so it fills the window.
    let linked_win = format!("{}:{}", linked, window_id);
    let _ = tmux(&["select-window", "-t", &linked_win]);

    let pane_index = tmux(&[
        "display-message", "-t", &format!("{}:{}.{}", linked, window_id, pane_id),
        "-p", "#{pane_index}",
    ]).unwrap_or_default();

    let zoom_target = if pane_index.is_empty() {
        format!("{}:{}.{}", linked, window_id, pane_id)
    } else {
        format!("{}:{}.{}", linked, window_id, pane_index)
    };
    let _ = tmux(&["select-pane", "-t", &zoom_target]);
    let _ = tmux(&["resize-pane", "-Z", "-t", &zoom_target]);

    Ok(linked)
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
        sink: OutputSink,
    ) -> Result<SpawnResult, String> {
        if self.sessions.contains_key(pane_id) {
            log::info!("[pty] destroying stale viewer for {} before re-spawn", pane_id);
            let _ = self.destroy(pane_id);
        }

        let event_key = pane_id.replace('%', "p");

        let pane_info = tmux(&[
            "display-message", "-t", pane_id,
            "-p", "#{pane_width} #{pane_height} #{session_name} #{window_id}",
        ])?;
        let parts: Vec<&str> = pane_info.split(' ').collect();
        if parts.len() < 4 {
            return Err(format!("Unexpected pane info: {}", pane_info));
        }
        let native_cols: u16 = parts[0].parse().unwrap_or(80);
        let native_rows: u16 = parts[1].parse().unwrap_or(24);
        let real_session = parts[2].to_string();
        let window_id = parts[3].to_string();

        // Create linked session with pane zoomed for independent resize.
        let linked = create_linked_session(pane_id, &real_session, &window_id)?;

        // Resize linked window to our viewport so the zoomed pane matches.
        if cols > 0 && rows > 0 {
            let target = format!("{}:{}", linked, window_id);
            let _ = tmux(&[
                "resize-window", "-t", &target,
                "-x", &cols.to_string(), "-y", &rows.to_string(),
            ]);
        }

        let stop = Arc::new(Mutex::new(false));
        let stop_clone = Arc::clone(&stop);
        let ctrl_event_key = event_key.clone();
        let ctrl_session = real_session.clone();
        let pane_id_for_thread = pane_id.to_string();
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};

            let mut child = match Command::new("tmux")
                .args(["-C", "attach-session", "-t", &ctrl_session, "-r"])
                .stdout(std::process::Stdio::piped())
                .stdin(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    log::error!("[pty {}] control mode spawn failed: {}", ctrl_event_key, e);
                    return;
                }
            };

            let _stdin = child.stdin.take();
            let stdout = match child.stdout.take() {
                Some(s) => s,
                None => {
                    log::error!("[pty {}] no stdout", ctrl_event_key);
                    return;
                }
            };

            log::info!("[pty {}] control mode started for session {}", ctrl_event_key, ctrl_session);

            let mut reader = BufReader::new(stdout);
            let target_prefix = format!("%output {} ", pane_id_for_thread);
            let target_bytes = target_prefix.as_bytes();

            // Wait for control mode %begin/%end handshake.
            let mut line_buf = Vec::with_capacity(8192);
            let mut ready = false;
            while !ready {
                line_buf.clear();
                match reader.read_until(b'\n', &mut line_buf) {
                    Ok(0) => break,
                    Err(_) => break,
                    Ok(_) => {}
                }
                if line_buf.starts_with(b"%end") || line_buf.starts_with(b"%begin") {
                    ready = true;
                }
                if line_buf.starts_with(b"%exit") { break; }
            }

            if ready {
                log::info!("[pty {}] control mode ready, sending RIS + C-l", ctrl_event_key);

                // RIS clears xterm.js before fresh content arrives.
                let reset = b"\x1bc".to_vec();
                match &sink {
                    OutputSink::Tauri(app_handle) => {
                        let _ = app_handle.emit(
                            &format!("pty-output-{}", ctrl_event_key), reset);
                    }
                    OutputSink::Channel(tx) => {
                        let _ = tx.send((pane_id_for_thread.clone(), reset));
                    }
                }

                // C-l forces a full redraw at the (now resized) pane dimensions.
                let _ = Command::new("tmux")
                    .args(["send-keys", "-t", &pane_id_for_thread, "C-l"])
                    .output();
            }

            loop {
                if *stop_clone.lock().unwrap() { break; }

                line_buf.clear();
                match reader.read_until(b'\n', &mut line_buf) {
                    Ok(0) => break,
                    Err(_) => break,
                    Ok(_) => {}
                }

                if line_buf.last() == Some(&b'\n') { line_buf.pop(); }
                if line_buf.starts_with(b"%exit") { break; }
                if !line_buf.starts_with(target_bytes) { continue; }

                let raw = &line_buf[target_bytes.len()..];
                let raw_str = match std::str::from_utf8(raw) {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                let data = decode_tmux_octal(raw_str);
                if data.is_empty() { continue; }

                match &sink {
                    OutputSink::Tauri(app_handle) => {
                        let _ = app_handle
                            .emit(&format!("pty-output-{}", ctrl_event_key), data);
                    }
                    OutputSink::Channel(tx) => {
                        let _ = tx.send((pane_id_for_thread.clone(), data));
                    }
                }
            }

            drop(_stdin);
            let _ = child.kill();
            let _ = child.wait();
        });

        self.sessions.insert(
            pane_id.to_string(),
            PaneViewer {
                linked_session: linked,
                window_id: window_id.clone(),
                stop,
            },
        );

        Ok(SpawnResult { native_cols, native_rows })
    }

    pub fn write(&mut self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let _session = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        let text = String::from_utf8_lossy(data);

        let tmux_key = match text.as_ref() {
            "\r" => Some("Enter"),
            "\x7f" => Some("BSpace"),
            "\x1b[A" => Some("Up"),
            "\x1b[B" => Some("Down"),
            "\x1b[C" => Some("Right"),
            "\x1b[D" => Some("Left"),
            "\x1b[H" => Some("Home"),
            "\x1b[F" => Some("End"),
            "\x1b[3~" => Some("DC"),
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

        let output = output.map_err(|e| format!("send-keys: {}", e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("send-keys: {}", stderr.trim()));
        }

        Ok(())
    }

    pub fn resize(&mut self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }

        let viewer = self.sessions.get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        let target = format!("{}:{}", viewer.linked_session, viewer.window_id);
        let _ = tmux(&[
            "resize-window", "-t", &target,
            "-x", &cols.to_string(), "-y", &rows.to_string(),
        ]);

        // C-l forces the app to redraw at the new size.
        let _ = tmux(&["send-keys", "-t", pane_id, "C-l"]);

        Ok(())
    }

    pub fn destroy(&mut self, pane_id: &str) -> Result<(), String> {
        if let Some(viewer) = self.sessions.remove(pane_id) {
            *viewer.stop.lock().unwrap() = true;

            // Kill linked session (unzooms and restores original layout)
            let _ = tmux(&["kill-session", "-t", &viewer.linked_session]);

            // Let tmux auto-size the window again
            let _ = tmux(&["resize-window", "-A", "-t", &viewer.window_id]);
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
