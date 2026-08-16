mod cache;
mod capture;
mod cleanup;
mod emit;
mod spawn;
mod viewer;

use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use portable_pty::PtySize;

use cache::RecentPaneCache;
use capture::{find_captured_window, release_captured_pane};
use cleanup::{cleanup_orphaned_ct_windows, cleanup_orphaned_view_sessions};
use emit::emit_initial_snapshot;
use viewer::PaneViewer;

pub use viewer::{OutputSink, SpawnResult};

pub struct PtyManager {
    sessions: HashMap<String, PaneViewer>,
    /// Session-local `window-size` values from before the first active viewer.
    /// tmux changes this option to `manual` whenever `resize-window` runs.
    window_size_options: HashMap<String, Option<String>>,
    recent: Arc<Mutex<RecentPaneCache>>,
}

impl PtyManager {
    fn remember_window_size_option(&mut self, session: &str) {
        if self.window_size_options.contains_key(session) {
            return;
        }
        let value = match crate::tmux::get_session_window_size(session) {
            Ok(value) => value,
            Err(error) => {
                log::warn!(
                    "failed to read tmux session {} window-size option: {}",
                    session,
                    error
                );
                // We are about to mutate the option. If tmux cannot report
                // the previous value, the safest cleanup is to return to the
                // session's inherited/global setting rather than leave the
                // session permanently in manual mode.
                None
            }
        };
        self.window_size_options.insert(session.to_string(), value);
    }

    fn stop_viewer(&mut self, viewer: PaneViewer) {
        viewer.stop.store(true, Ordering::Relaxed);
        let _ = crate::tmux::kill_session(&viewer.view_session);
        if !viewer.moved {
            let _ = crate::tmux::resize_window(
                &viewer.window_id,
                viewer.native_cols,
                viewer.native_rows,
            );
        }

        let session = viewer.tmux_session;
        let has_active_viewer = self
            .sessions
            .values()
            .any(|active| active.tmux_session == session);
        if !has_active_viewer {
            if let Some(original) = self.window_size_options.remove(&session) {
                // resize-window switches the session to manual sizing. Refit
                // the window against the remaining attached session before
                // restoring the previous option so the terminal is full-sized
                // immediately, even when Alacritty changed size while the
                // viewer was active.
                let _ = crate::tmux::resize_window_to_largest_session(&viewer.window_id);
                if let Err(error) =
                    crate::tmux::restore_session_window_size(&session, original.as_deref())
                {
                    log::warn!(
                        "failed to restore tmux session {} window-size option: {}",
                        session,
                        error
                    );
                }
            }
        }
    }
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
            window_size_options: HashMap::new(),
            recent: Arc::new(Mutex::new(RecentPaneCache::new())),
        }
    }

    pub fn active_pane_ids(&mut self) -> std::collections::HashSet<String> {
        self.reap_dead_viewers();
        self.sessions.keys().cloned().collect()
    }

    /// Remove viewers whose PTY reader has exited. Process discovery calls this
    /// regularly, so grouped view sessions are cleaned up even when frontend
    /// teardown was interrupted or the tmux attach process died unexpectedly.
    fn reap_dead_viewers(&mut self) {
        let dead_panes: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, viewer)| !viewer.alive.load(Ordering::Relaxed))
            .map(|(pane_id, _)| pane_id.clone())
            .collect();

        for pane_id in dead_panes {
            log::info!("[pty {}] reaping dead viewer during process scan", pane_id);
            if let Some(viewer) = self.sessions.remove(&pane_id) {
                self.stop_viewer(viewer);
            }
        }
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
        self.recent.lock().get(pane_id)
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
            .write_all(data)
            .map_err(|e| format!("pty write: {}", e))?;
        Ok(())
    }

    pub fn resize(&mut self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Ok(());
        }

        let session = self
            .sessions
            .get(pane_id)
            .map(|viewer| viewer.tmux_session.clone())
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;
        // Keep the restore record adjacent to every operation that can switch
        // tmux's window-size option to manual. This also covers a viewer that
        // started before its first non-zero resize event.
        self.remember_window_size_option(&session);

        let viewer = self
            .sessions
            .get(pane_id)
            .ok_or_else(|| format!("No viewer for pane {}", pane_id))?;

        viewer
            .master
            .lock()
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
            // Dedicated ct-* captures remain parked for an explicit release.
            // In-place single-pane views return to their desktop size here.
            self.stop_viewer(viewer);
        }
        Ok(())
    }

    pub fn release(&mut self, pane_id: &str) -> Result<(), String> {
        let moved = self.sessions.get(pane_id).map(|viewer| viewer.moved);
        let _ = self.destroy(pane_id, None);
        if moved == Some(false) || (moved.is_none() && find_captured_window(pane_id).is_none()) {
            return Ok(());
        }
        // `kill-session` completes the grouped view-session teardown before it
        // returns, so the pane can be restored synchronously without a delay.
        release_captured_pane(pane_id)
    }

    pub fn destroy_all(&mut self) {
        let pane_ids: Vec<String> = self.sessions.keys().cloned().collect();
        for pane_id in pane_ids {
            let _ = self.destroy(&pane_id, None);
        }
    }

    /// Release every captured pane back to its origin tmux window.
    /// Returns the pane IDs that were released so callers can log or report.
    pub fn suspend_all(&mut self) -> Vec<String> {
        let pane_ids: Vec<String> = self.sessions.keys().cloned().collect();
        let mut released = Vec::new();
        for pane_id in &pane_ids {
            if let Err(e) = self.release(pane_id) {
                log::warn!("suspend_all: release {} failed: {}", pane_id, e);
                continue;
            }
            released.push(pane_id.clone());
        }
        released
    }
}

pub type SharedPtyManager = Arc<Mutex<PtyManager>>;
