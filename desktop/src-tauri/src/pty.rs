use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// A pane viewer that creates a linked tmux session, zooms the target pane,
/// and resizes the window to match the xterm.js viewport.  Uses tmux control
/// mode (`tmux -C`) for real-time output streaming and `send-keys` for input.
///
/// On destroy, the linked session is killed and the window is restored to
/// automatic sizing, so the real terminal regains its original dimensions.
struct PaneViewer {
    pane_id: String,
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
    ) -> Result<(), String> {
        if self.sessions.contains_key(pane_id) {
            return Err(format!("Viewer already exists for pane {}", pane_id));
        }

        let stop = Arc::new(Mutex::new(false));
        let stop_clone = Arc::clone(&stop);
        let pane_id_owned = pane_id.to_string();
        let event_key = pane_id.replace('%', "p");

        // Find the real session and window for this pane
        let real_session = tmux(&[
            "display-message", "-t", pane_id, "-p", "#{session_name}",
        ])?;
        let window_id = tmux(&[
            "display-message", "-t", pane_id, "-p", "#{window_id}",
        ])?;

        // Create a linked session grouped with the real one
        let linked = format!("clawtab-view-{}", event_key);
        let _ = tmux(&["kill-session", "-t", &linked]); // clean stale

        tmux(&["new-session", "-d", "-s", &linked, "-t", &real_session])?;

        // Mark the linked session as "manual" so its smaller viewport
        // does not constrain the shared window group.
        let _ = tmux(&["set-option", "-s", "-t", &linked, "window-size", "manual"]);

        // Select the correct window and zoom the target pane
        let linked_win = format!("{}:{}", linked, window_id);
        let _ = tmux(&["select-window", "-t", &linked_win]);
        let pane_index = tmux(&[
            "display-message", "-t", &format!("{}:{}.{}", linked, window_id, pane_id_owned),
            "-p", "#{pane_index}",
        ]).unwrap_or_default();
        let zoom_target = if pane_index.is_empty() {
            format!("{}:{}.{}", linked, window_id, pane_id_owned)
        } else {
            format!("{}:{}.{}", linked, window_id, pane_index)
        };
        let _ = tmux(&["select-pane", "-t", &zoom_target]);
        let _ = tmux(&["resize-pane", "-Z", "-t", &zoom_target]);

        // Resize the window to match the xterm.js viewport
        let w = if cols > 0 { cols } else { 80 };
        let h = if rows > 0 { rows } else { 24 };
        let _ = tmux(&[
            "resize-window", "-t", &linked_win,
            "-x", &w.to_string(), "-y", &h.to_string(),
        ]);

        // Use tmux control mode for real-time output streaming.
        // `tmux -C attach -t <session>` sends `%output <pane> <data>`
        // lines with no internal buffering.
        let ctrl_event_key = event_key.clone();
        let ctrl_linked = linked.clone();
        let pane_id_for_thread = pane_id.to_string();
        thread::spawn(move || {
            use std::io::{BufRead, BufReader, Write};

            let mut child = match Command::new("tmux")
                .args(["-C", "attach-session", "-t", &ctrl_linked])
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

            // Take stdin before stdout - we need to keep it alive for the
            // entire duration or the control mode client will exit.
            let mut stdin = match child.stdin.take() {
                Some(s) => s,
                None => {
                    log::error!("[pty {}] no stdin", ctrl_event_key);
                    return;
                }
            };
            let stdout = match child.stdout.take() {
                Some(s) => s,
                None => {
                    log::error!("[pty {}] no stdout", ctrl_event_key);
                    return;
                }
            };

            log::info!("[pty {}] control mode started for {}", ctrl_event_key, ctrl_linked);

            // Capture current screen content and send it as initial output,
            // then send C-l to trigger a refresh so ongoing changes stream through.
            match tmux(&["capture-pane", "-t", &pane_id_for_thread, "-p", "-e"]) {
                Ok(content) if !content.is_empty() => {
                    // capture-pane -e returns text with ANSI escapes preserved.
                    // Wrap in a clear-screen + content to initialize xterm.js.
                    let mut init = Vec::new();
                    init.extend_from_slice(b"\x1b[2J\x1b[H"); // clear + home
                    init.extend_from_slice(content.as_bytes());
                    match &sink {
                        OutputSink::Tauri(app_handle) => {
                            let _ = app_handle
                                .emit(&format!("pty-output-{}", ctrl_event_key), init);
                        }
                        OutputSink::Channel(tx) => {
                            let _ = tx.send((pane_id_for_thread.clone(), init));
                        }
                    }
                }
                _ => {}
            }

            // Trigger refresh so the app redraws and streams through control mode
            let _ = writeln!(stdin, "send-keys -t {} C-l", pane_id_for_thread);

            // Read raw bytes and split on newlines - control mode output
            // can contain non-UTF-8 sequences in %output data.
            let mut reader = BufReader::new(stdout);
            let target_prefix = format!("%output {} ", pane_id_for_thread);
            let target_bytes = target_prefix.as_bytes();

            let mut line_buf = Vec::with_capacity(8192);
            loop {
                if *stop_clone.lock().unwrap() { break; }

                line_buf.clear();
                match reader.read_until(b'\n', &mut line_buf) {
                    Ok(0) => break, // EOF
                    Err(_) => break,
                    Ok(_) => {}
                }

                // Trim trailing newline
                if line_buf.last() == Some(&b'\n') { line_buf.pop(); }

                // Check for %exit
                if line_buf.starts_with(b"%exit") { break; }

                // Only process %output lines for our target pane
                if !line_buf.starts_with(target_bytes) { continue; }

                let raw = &line_buf[target_bytes.len()..];
                // raw is octal-escaped ASCII, safe to treat as str
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

            drop(stdin);
            let _ = child.kill();
            let _ = child.wait();
        });

        self.sessions.insert(
            pane_id.to_string(),
            PaneViewer {
                pane_id: pane_id.to_string(),
                linked_session: linked,
                window_id: window_id.clone(),
                stop,
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
        let session = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        if cols > 0 && rows > 0 {
            let target = format!("{}:{}", session.linked_session, session.window_id);
            let _ = tmux(&[
                "resize-window", "-t", &target,
                "-x", &cols.to_string(), "-y", &rows.to_string(),
            ]);
        }
        Ok(())
    }

    /// Temporarily restore the tmux window to automatic sizing so the real
    /// terminal (Alacritty) can reclaim its full dimensions.  Called when the
    /// clawtab window loses focus.
    pub fn restore_size(&self, pane_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        let _ = tmux(&["set-option", "-u", "-w", "-t", &session.window_id, "window-size"]);
        let _ = tmux(&["resize-window", "-A", "-t", &session.window_id]);
        Ok(())
    }

    pub fn destroy(&mut self, pane_id: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.remove(pane_id) {
            *session.stop.lock().unwrap() = true;

            // Unzoom the pane in the linked session before killing it
            let _ = tmux(&["resize-pane", "-Z", "-t", &session.pane_id]);

            // Kill the linked session (also terminates control mode client)
            let _ = tmux(&["kill-session", "-t", &session.linked_session]);

            // Restore automatic window sizing so the real terminal regains
            // its original dimensions
            let _ = tmux(&["set-option", "-u", "-w", "-t", &session.window_id, "window-size"]);
            let _ = tmux(&["resize-window", "-A", "-t", &session.window_id]);
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
