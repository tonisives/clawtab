use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

struct PtySession {
    child: Box<dyn portable_pty::Child + Send>,
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    grouped_session: String,
}

pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
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
        tmux_session: &str,
        cols: u16,
        rows: u16,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        if self.sessions.contains_key(pane_id) {
            return Err(format!("PTY already exists for pane {}", pane_id));
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        // Create a grouped session so the real terminal is unaffected
        let grouped_session = format!("clawtab-view-{}", pane_id.replace('%', ""));

        // Create the grouped session (detached, via normal process - not the PTY)
        let output = std::process::Command::new("tmux")
            .args([
                "new-session",
                "-d",
                "-t",
                tmux_session,
                "-s",
                &grouped_session,
            ])
            .output()
            .map_err(|e| format!("Failed to create grouped session: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("tmux new-session failed: {}", stderr.trim()));
        }

        // Select the target pane in the grouped session
        let _ = std::process::Command::new("tmux")
            .args(["select-pane", "-t", pane_id])
            .output();

        // Attach to the grouped session inside the PTY
        let mut attach_cmd = CommandBuilder::new("tmux");
        attach_cmd.args(["attach-session", "-t", &grouped_session]);

        let child = pair
            .slave
            .spawn_command(attach_cmd)
            .map_err(|e| format!("Failed to attach tmux: {}", e))?;

        // Take writer (can only be called once per MasterPty)
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

        // Spawn reader thread
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

        // Sanitize pane_id for event names (% is not allowed in Tauri events)
        let event_key = pane_id.replace('%', "p");
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = app_handle.emit(&format!("pty-exit-{}", event_key), ());
                        break;
                    }
                    Ok(n) => {
                        let encoded =
                            base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        let _ =
                            app_handle.emit(&format!("pty-output-{}", event_key), encoded);
                    }
                    Err(_) => {
                        let _ = app_handle.emit(&format!("pty-exit-{}", event_key), ());
                        break;
                    }
                }
            }
        });

        self.sessions.insert(
            pane_id.to_string(),
            PtySession {
                child,
                writer,
                master: pair.master,
                grouped_session,
            },
        );

        Ok(())
    }

    pub fn write(&mut self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(pane_id)
            .ok_or_else(|| format!("No PTY session for pane {}", pane_id))?;

        use std::io::Write;
        session
            .writer
            .write_all(data)
            .map_err(|e| format!("Failed to write to PTY: {}", e))
    }

    pub fn resize(&mut self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self
            .sessions
            .get_mut(pane_id)
            .ok_or_else(|| format!("No PTY session for pane {}", pane_id))?;

        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {}", e))
    }

    pub fn destroy(&mut self, pane_id: &str) -> Result<(), String> {
        if let Some(mut session) = self.sessions.remove(pane_id) {
            // Kill the child process
            let _ = session.child.kill();
            let _ = session.child.wait();

            // Kill the grouped tmux session
            let _ = std::process::Command::new("tmux")
                .args(["kill-session", "-t", &session.grouped_session])
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
