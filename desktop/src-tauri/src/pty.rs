use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

/// Pane viewer: captured pane in a clawtab-<group> session, streamed via a
/// local PTY running `tmux attach-session` against an ephemeral grouped view
/// session. This gives us independent resize on the captured window without
/// disturbing other clients of the real tmux server.
struct PaneViewer {
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Captured window id (@...) in the clawtab-<group> session.
    window_id: String,
    /// Ephemeral grouped view session (clawtab-<group>-view-N); killed on stop.
    view_session: String,
}

/// Where PTY output bytes should be sent.
pub enum OutputSink {
    /// Emit as Tauri event (local desktop xterm.js)
    Tauri(AppHandle),
    /// Send via channel (relay forwarding to remote clients)
    Channel(std::sync::mpsc::Sender<(String, Vec<u8>)>),
}

/// Returned from spawn so the frontend knows the pane's native size at capture time.
pub struct SpawnResult {
    pub native_cols: u16,
    pub native_rows: u16,
}

pub struct PtyManager {
    sessions: HashMap<String, PaneViewer>,
}

static VIEW_COUNTER: AtomicU64 = AtomicU64::new(0);

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

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

fn capture_session_name(group: &str) -> String {
    format!("clawtab-{}", group)
}

/// Make sure the capture session exists. Creates it with a placeholder window
/// if not present. The placeholder keeps the session alive when no panes are
/// captured.
fn ensure_capture_session(group: &str) -> Result<String, String> {
    let session = capture_session_name(group);
    let exists = Command::new("tmux")
        .args(["has-session", "-t", &session])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !exists {
        tmux(&[
            "new-session", "-d", "-s", &session,
            "-n", "__placeholder", "-x", "80", "-y", "24",
            "sh", "-c", "while :; do sleep 3600; done",
        ])?;
        // Hide status bar for clients attaching to this session
        let _ = tmux(&["set-option", "-t", &session, "status", "off"]);
    }
    Ok(session)
}

/// Returns Some((session, window_id)) if the pane is already in a clawtab capture session.
fn find_captured_window(pane_id: &str) -> Option<(String, String)> {
    let info = tmux(&[
        "display-message", "-t", pane_id,
        "-p", "#{session_name}\t#{window_id}",
    ]).ok()?;
    let parts: Vec<&str> = info.split('\t').collect();
    if parts.len() == 2 && parts[0].starts_with("clawtab-") {
        Some((parts[0].to_string(), parts[1].to_string()))
    } else {
        None
    }
}

/// Break a pane into its own window inside the capture session for `group`.
/// Records origin as a window option. Returns the new window id.
/// Idempotent: if already captured, returns the existing window id.
fn capture_pane(pane_id: &str, group: &str) -> Result<String, String> {
    if let Some((_, win_id)) = find_captured_window(pane_id) {
        return Ok(win_id);
    }

    let session = ensure_capture_session(group)?;

    // Record origin BEFORE break-pane
    let origin = tmux(&[
        "display-message", "-t", pane_id,
        "-p", "#{session_name}\t#{window_id}\t#{pane_index}\t#{window_name}",
    ])?;

    // break-pane moves the pane into a new window in the target session
    tmux(&[
        "break-pane", "-d",
        "-s", pane_id,
        "-t", &format!("{}:", session),
    ])?;

    // After break-pane, the pane_id is stable. Look up its new window.
    let new_win = tmux(&[
        "display-message", "-t", pane_id, "-p", "#{window_id}",
    ])?;

    // Store origin on the new window as a user option
    let _ = tmux(&[
        "set-option", "-w", "-t", &new_win,
        "@clawtab-origin", &origin,
    ]);

    Ok(new_win)
}

/// Release a captured pane back to its original session:window.
///
/// If the original window still exists in the original session, the pane is
/// joined back into it. If the original window is gone (because the pane was
/// the last one in it when captured, and break-pane migrated the window_id),
/// a new window with the original name is created in the original session.
/// If the original session is also gone, a new session with the original name
/// is created.
fn release_captured_pane(pane_id: &str) -> Result<(), String> {
    let (_, _cap_win) = find_captured_window(pane_id)
        .ok_or("pane is not captured")?;

    // Read origin from the current (captured) window of the pane.
    let cap_win_now = tmux(&[
        "display-message", "-t", pane_id, "-p", "#{window_id}",
    ])?;
    let origin = tmux(&[
        "show-options", "-w", "-v", "-t", &cap_win_now, "@clawtab-origin",
    ]).map_err(|e| format!("no origin recorded: {}", e))?;

    let parts: Vec<&str> = origin.split('\t').collect();
    if parts.len() < 2 {
        return Err(format!("malformed origin: {}", origin));
    }
    let orig_session = parts[0];
    let orig_window = parts[1];
    let orig_window_name = parts.get(3).copied().unwrap_or("");

    // Does the original session still exist?
    let session_exists = Command::new("tmux")
        .args(["has-session", "-t", orig_session])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !session_exists {
        tmux(&[
            "new-session", "-d", "-s", orig_session,
            "-n", "__tmp", "sh", "-c", "while :; do sleep 3600; done",
        ])?;
        let name = if orig_window_name.is_empty() { "restored" } else { orig_window_name };
        tmux(&[
            "break-pane", "-d",
            "-s", pane_id,
            "-t", &format!("{}:", orig_session),
            "-n", name,
        ])?;
        let _ = tmux(&["kill-window", "-t", &format!("{}:__tmp", orig_session)]);
        return Ok(());
    }

    // Does the original window still belong to the original session?
    // Note: @window_id is globally unique in tmux, but `display-message -t session:@id`
    // resolves the window_id globally and ignores the session prefix. So we have to
    // check session membership explicitly by listing the windows of orig_session.
    let windows_in_session = tmux(&[
        "list-windows", "-t", orig_session, "-F", "#{window_id}",
    ]).unwrap_or_default();
    let window_exists = windows_in_session.lines().any(|l| l.trim() == orig_window);

    if window_exists {
        tmux(&["join-pane", "-s", pane_id, "-t", orig_window])?;
        if !orig_window_name.is_empty() {
            let _ = tmux(&["rename-window", "-t", orig_window, orig_window_name]);
        }
    } else {
        let name = if orig_window_name.is_empty() { "restored" } else { orig_window_name };
        tmux(&[
            "break-pane", "-d",
            "-s", pane_id,
            "-t", &format!("{}:", orig_session),
            "-n", name,
        ])?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// PtyManager
// ---------------------------------------------------------------------------

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
        group: &str,
        sink: OutputSink,
    ) -> Result<SpawnResult, String> {
        if self.sessions.contains_key(pane_id) {
            log::info!("[pty] destroying stale viewer for {} before re-spawn", pane_id);
            let _ = self.destroy(pane_id);
        }

        // Read the pane's native size before capture. After capture + resize we
        // mutate it, so this captures the "original" view the user expected.
        let native_info = tmux(&[
            "display-message", "-t", pane_id,
            "-p", "#{pane_width} #{pane_height}",
        ])?;
        let native_parts: Vec<&str> = native_info.split(' ').collect();
        let native_cols: u16 = native_parts.first().and_then(|s| s.parse().ok()).unwrap_or(80);
        let native_rows: u16 = native_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(24);

        // Capture the pane into our group's session (idempotent).
        let window_id = capture_pane(pane_id, group)?;
        let base_session = capture_session_name(group);

        // Ephemeral grouped view session so this viewer has its own current-window.
        let view_id = VIEW_COUNTER.fetch_add(1, Ordering::Relaxed);
        let view_session = format!("{}-view-{}", base_session, view_id);
        tmux(&[
            "new-session", "-d",
            "-s", &view_session,
            "-t", &base_session,
        ])?;
        let _ = tmux(&["set-option", "-t", &view_session, "status", "off"]);
        tmux(&[
            "select-window",
            "-t", &format!("{}:{}", view_session, window_id),
        ])?;

        // Open a local PTY and spawn `tmux attach-session` inside it.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {}", e))?;

        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(["attach-session", "-t", &view_session]);
        cmd.env("TERM", "xterm-256color");

        let _child = pair.slave
            .spawn_command(cmd)
            .map_err(|e| format!("tmux attach spawn: {}", e))?;
        drop(pair.slave);

        let mut reader = pair.master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {}", e))?;
        let writer = pair.master
            .take_writer()
            .map_err(|e| format!("take writer: {}", e))?;
        let writer = Arc::new(Mutex::new(writer));
        let master = Arc::new(Mutex::new(pair.master));

        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);
        let event_key = pane_id.replace('%', "p");
        let pane_id_for_thread = pane_id.to_string();

        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                if stop_clone.load(Ordering::Relaxed) { break; }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let bytes = buf[..n].to_vec();
                        match &sink {
                            OutputSink::Tauri(app_handle) => {
                                let _ = app_handle
                                    .emit(&format!("pty-output-{}", event_key), bytes);
                            }
                            OutputSink::Channel(tx) => {
                                let _ = tx.send((pane_id_for_thread.clone(), bytes));
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            log::debug!("[pty {}] reader thread exited", event_key);
        });

        // Resize the captured window to match the viewport so content reflows.
        if cols > 0 && rows > 0 {
            let _ = tmux(&[
                "resize-window", "-t", &window_id,
                "-x", &cols.to_string(), "-y", &rows.to_string(),
            ]);
        }

        self.sessions.insert(
            pane_id.to_string(),
            PaneViewer {
                stop,
                writer,
                master,
                window_id,
                view_session,
            },
        );

        Ok(SpawnResult { native_cols, native_rows })
    }

    pub fn write(&mut self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let viewer = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;
        viewer.writer.lock().unwrap()
            .write_all(data)
            .map_err(|e| format!("pty write: {}", e))?;
        Ok(())
    }

    pub fn resize(&mut self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }

        let viewer = self.sessions.get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        viewer.master.lock().unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("pty resize: {}", e))?;

        let _ = tmux(&[
            "resize-window", "-t", &viewer.window_id,
            "-x", &cols.to_string(), "-y", &rows.to_string(),
        ]);

        Ok(())
    }

    pub fn destroy(&mut self, pane_id: &str) -> Result<(), String> {
        if let Some(viewer) = self.sessions.remove(pane_id) {
            viewer.stop.store(true, Ordering::Relaxed);
            // Kill only the ephemeral view session. The captured window stays
            // in clawtab-<group> so the user can re-attach or release later.
            let _ = tmux(&["kill-session", "-t", &viewer.view_session]);
        }
        Ok(())
    }

    pub fn release(&mut self, pane_id: &str) -> Result<(), String> {
        let _ = self.destroy(pane_id);
        // Give tmux a moment for the PTY to detach before moving the pane.
        thread::sleep(Duration::from_millis(100));
        release_captured_pane(pane_id)
    }

    pub fn destroy_all(&mut self) {
        let pane_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for pane_id in pane_ids {
            let _ = self.destroy(&pane_id);
        }
    }
}

pub type SharedPtyManager = Arc<Mutex<PtyManager>>;
