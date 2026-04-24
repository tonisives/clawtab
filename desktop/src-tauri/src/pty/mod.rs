mod cache;
mod capture;
mod cleanup;
mod emit;
mod spawn;
mod viewer;

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::PtySize;

use cache::RecentPaneCache;
use capture::release_captured_pane;
use cleanup::{cleanup_orphaned_ct_windows, cleanup_orphaned_view_sessions};
use emit::emit_initial_snapshot;
use viewer::PaneViewer;

pub use viewer::{OutputSink, SpawnResult};

pub struct PtyManager {
    sessions: HashMap<String, PaneViewer>,
    recent: Arc<Mutex<RecentPaneCache>>,
}

// ---------------------------------------------------------------------------
// PtyManager
// ---------------------------------------------------------------------------

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        // On startup, self.sessions is empty — any existing clawtab-*-view-*
        // session is an orphan from a previous run. View sweep first so the
        // ct-* sweep doesn't see panes under view sessions.
        cleanup_orphaned_view_sessions(&[]);
        // Read protected pane IDs persisted by the daemon's last SetProtectedPanes
        // IPC. The webview has not booted yet, so we cannot ask the frontend.
        // Without this, plain idle shells get swept before the user sees them.
        let protected = crate::config::protected_panes::load_set();
        cleanup_orphaned_ct_windows(&protected);
        Self {
            sessions: HashMap::new(),
            recent: Arc::new(Mutex::new(RecentPaneCache::new())),
        }
    }

    pub fn active_pane_ids(&self) -> std::collections::HashSet<String> {
        self.sessions.keys().cloned().collect()
    }

    /// Re-assert each viewer session's intended active window. Required after
    /// any `tmux new-window -t base_session` because tmux pulls every grouped
    /// peer session's active to the newly created window — even with `-d`.
    /// Without this, all attached PTY readers start streaming the new pane's
    /// output instead of the one they were created for.
    pub fn restore_view_session_windows(&self) {
        for (pane_id, viewer) in &self.sessions {
            let target = format!("{}:{}", viewer.view_session, viewer.window_id);
            if let Err(e) = crate::tmux::select_window(&target) {
                log::warn!(
                    "[pty {}] restore select-window {} failed: {}",
                    pane_id,
                    target,
                    e
                );
            }
        }
    }

    /// Create a new clawtab-managed tmux window and immediately re-assert every
    /// viewer session's intended active window. Always prefer this over calling
    /// `tmux::create_window_with_cwd` directly — the restore step is required
    /// after any `new-window` in a grouped base session. See
    /// `restore_view_session_windows` for why.
    pub fn spawn_window(
        &self,
        session: &str,
        name_prefix: &str,
        cwd: Option<&str>,
        env: &[(String, String)],
    ) -> Result<(String, String), String> {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let window_name = format!("{}-{}", name_prefix, suffix);
        let pane = crate::tmux::create_window_with_cwd(session, &window_name, cwd, env)?;
        self.restore_view_session_windows();
        Ok((pane, window_name))
    }

    pub fn spawn(
        &mut self,
        pane_id: &str,
        tmux_session: &str,
        cols: u16,
        rows: u16,
        _group: &str,
        sink: OutputSink,
    ) -> Result<SpawnResult, String> {
        spawn::run(self, pane_id, tmux_session, cols, rows, sink)
    }

    pub fn get_cached_output(&self, pane_id: &str) -> Vec<u8> {
        self.recent.lock().unwrap().get(pane_id)
    }

    /// Re-emit a fresh snapshot for a pane that already has an active viewer.
    /// Used as a fallback when the frontend's initial snapshot delivery was lost.
    pub fn refresh_snapshot(&self, pane_id: &str, sink: &OutputSink) -> Result<(), String> {
        if !self.sessions.contains_key(pane_id) {
            return Err(format!("No viewer for pane {}", pane_id));
        }
        log::info!("[pty {}] refresh_snapshot requested", pane_id);
        emit_initial_snapshot(sink, &self.recent, pane_id);
        Ok(())
    }

    pub fn write(&mut self, pane_id: &str, data: &[u8]) -> Result<(), String> {
        let viewer = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;
        viewer
            .writer
            .lock()
            .unwrap()
            .write_all(data)
            .map_err(|e| format!("pty write: {}", e))?;
        Ok(())
    }

    pub fn resize(&mut self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }

        let viewer = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        viewer
            .master
            .lock()
            .unwrap()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("pty resize: {}", e))?;

        let _ = crate::tmux::resize_window(&viewer.window_id, cols, rows);

        Ok(())
    }

    pub fn destroy(
        &mut self,
        pane_id: &str,
        expected_generation: Option<u64>,
    ) -> Result<(), String> {
        if let Some(expected) = expected_generation {
            if let Some(viewer) = self.sessions.get(pane_id) {
                if viewer.attach_generation != expected {
                    return Ok(());
                }
            } else {
                return Ok(());
            }
        }

        if let Some(viewer) = self.sessions.remove(pane_id) {
            viewer.stop.store(true, Ordering::Relaxed);
            // Kill only the ephemeral view session. The captured window stays
            // in clawtab-<group> so the user can re-attach or release later.
            let _ = crate::tmux::kill_session(&viewer.view_session);
        }
        Ok(())
    }

    pub fn release(&mut self, pane_id: &str) -> Result<(), String> {
        let _ = self.destroy(pane_id, None);
        // Give tmux a moment for the PTY to detach before moving the pane.
        thread::sleep(Duration::from_millis(100));
        release_captured_pane(pane_id)
    }

    pub fn destroy_all(&mut self) {
        let pane_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for pane_id in pane_ids {
            let _ = self.destroy(&pane_id, None);
        }
    }
}

pub type SharedPtyManager = Arc<Mutex<PtyManager>>;
