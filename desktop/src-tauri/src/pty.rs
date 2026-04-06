use base64::Engine;
use std::collections::HashMap;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

/// A pane viewer that creates a linked tmux session, zooms the target pane,
/// and resizes the window to match the xterm.js viewport.  Uses `pipe-pane`
/// for live output streaming and `send-keys` for input.
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
        // does not constrain the shared window group.  Without this,
        // tmux sizes every window to the smallest attached session,
        // which keeps the real terminal (Alacritty) at clawtab's size
        // even after the user switches back.
        let _ = tmux(&["set-option", "-s", "-t", &linked, "window-size", "manual"]);

        // Select the correct window and zoom the target pane so it fills
        // the entire window (no splitting with other panes)
        let linked_win = format!("{}:{}", linked, window_id);
        let linked_pane = format!("{}.{}", linked_win, pane_id_owned);
        let _ = tmux(&["select-window", "-t", &linked_win]);
        let _ = tmux(&["select-pane", "-t", &linked_pane]);
        let _ = tmux(&["resize-pane", "-Z", "-t", &linked_pane]);

        // Resize the window to match the xterm.js viewport.
        // resize-window automatically sets window-size to manual.
        let w = if cols > 0 { cols } else { 80 };
        let h = if rows > 0 { rows } else { 24 };
        let _ = tmux(&[
            "resize-window", "-t", &linked_win,
            "-x", &w.to_string(), "-y", &h.to_string(),
        ]);

        // Write pipe-pane output to a regular file; use kqueue to wake
        // on every write so we get near-instant delivery without polling.
        let pipe_path = format!("/tmp/clawtab-pipe-{}", event_key);
        let _ = std::fs::remove_file(&pipe_path);
        std::fs::File::create(&pipe_path)
            .map_err(|e| format!("create {}: {}", pipe_path, e))?;

        tmux(&[
            "pipe-pane", "-t", &pane_id_owned,
            &format!("cat >> {}", pipe_path),
        ])?;

        // Give the app a moment to redraw at the new size, then force a
        // screen refresh so the full content flows through pipe-pane into
        // xterm.js as a single clean stream.
        thread::sleep(std::time::Duration::from_millis(200));
        let _ = tmux(&["send-keys", "-t", &pane_id_owned, "C-l"]);

        let pipe_event_key = event_key.clone();
        let pipe_path_clone = pipe_path.clone();
        let pane_id_for_thread = pane_id.to_string();
        thread::spawn(move || {
            use std::io::{Read, Seek, SeekFrom};

            let mut file = loop {
                if *stop_clone.lock().unwrap() { return; }
                match std::fs::File::open(&pipe_path_clone) {
                    Ok(f) => break f,
                    Err(_) => thread::sleep(std::time::Duration::from_millis(50)),
                }
            };

            // Set up kqueue to watch for writes (EVFILT_VNODE + NOTE_WRITE)
            let kq = unsafe { libc::kqueue() };
            if kq < 0 {
                log::error!("[pty {}] kqueue failed: {}", pipe_event_key, std::io::Error::last_os_error());
                return;
            }

            use std::os::unix::io::AsRawFd;
            let file_fd = file.as_raw_fd();
            let changelist = libc::kevent {
                ident: file_fd as usize,
                filter: libc::EVFILT_VNODE,
                flags: libc::EV_ADD | libc::EV_CLEAR,
                fflags: libc::NOTE_WRITE | libc::NOTE_DELETE,
                data: 0,
                udata: std::ptr::null_mut(),
            };

            let rc = unsafe {
                libc::kevent(
                    kq,
                    &changelist as *const libc::kevent,
                    1,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null(),
                )
            };
            if rc < 0 {
                log::error!("[pty {}] kevent register failed: {}", pipe_event_key, std::io::Error::last_os_error());
                unsafe { libc::close(kq); }
                return;
            }

            // Seek to end so we only read new data
            let _ = file.seek(SeekFrom::End(0));

            let mut buf = [0u8; 65536];
            let mut last_read = std::time::Instant::now();
            let timeout = libc::timespec { tv_sec: 1, tv_nsec: 0 };
            loop {
                if *stop_clone.lock().unwrap() { break; }

                // Wait for file write notification (1s timeout for stop check)
                let mut event_buf = [libc::kevent {
                    ident: 0, filter: 0, flags: 0, fflags: 0, data: 0,
                    udata: std::ptr::null_mut(),
                }; 1];
                let nev = unsafe {
                    libc::kevent(
                        kq,
                        std::ptr::null(),
                        0,
                        event_buf.as_mut_ptr(),
                        1,
                        &timeout as *const libc::timespec,
                    )
                };

                if nev < 0 { break; }
                if nev == 0 { continue; } // timeout, check stop flag

                // File was deleted (pipe-pane stopped)
                if event_buf[0].fflags & libc::NOTE_DELETE != 0 { break; }

                // Read all new data
                let t0 = std::time::Instant::now();
                match file.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        let read_ms = t0.elapsed().as_millis();
                        let gap_ms = last_read.elapsed().as_millis();
                        last_read = std::time::Instant::now();

                        let data = &buf[..n];
                        match &sink {
                            OutputSink::Tauri(app_handle) => {
                                let encoded =
                                    base64::engine::general_purpose::STANDARD.encode(data);
                                let emit_t = std::time::Instant::now();
                                let _ = app_handle
                                    .emit(&format!("pty-output-{}", pipe_event_key), encoded);
                                let emit_ms = emit_t.elapsed().as_millis();
                                if gap_ms > 200 || read_ms > 50 || emit_ms > 10 {
                                    log::warn!(
                                        "[pty {}] gap={}ms read={}ms emit={}ms bytes={}",
                                        pipe_event_key, gap_ms, read_ms, emit_ms, n
                                    );
                                }
                            }
                            OutputSink::Channel(tx) => {
                                let _ = tx.send((pane_id_for_thread.clone(), data.to_vec()));
                            }
                        }
                    }
                    Err(_) => {}
                }
            }
            unsafe { libc::close(kq); }
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

            // Stop pipe-pane
            let _ = tmux(&["pipe-pane", "-t", &session.pane_id]);

            // Unzoom the pane in the linked session before killing it
            let linked_pane = format!(
                "{}:{}.{}",
                session.linked_session, session.window_id, session.pane_id
            );
            let _ = tmux(&["resize-pane", "-Z", "-t", &linked_pane]);

            // Kill the linked session
            let _ = tmux(&["kill-session", "-t", &session.linked_session]);

            // Restore automatic window sizing so the real terminal regains
            // its original dimensions
            let _ = tmux(&["set-option", "-u", "-w", "-t", &session.window_id, "window-size"]);
            let _ = tmux(&["resize-window", "-A", "-t", &session.window_id]);

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
