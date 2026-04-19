use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::MasterPty;
#[cfg(feature = "desktop")]
use tauri::AppHandle;

use crate::debug_spawn;

/// Pane viewer: captured pane moved into a new `ct-<orig>-<N>` window in its
/// original tmux session, streamed via a local PTY running `tmux attach-session`
/// against an ephemeral grouped view session. This gives us independent resize
/// on the captured window without disturbing other clients of the real tmux
/// server, while keeping the pane discoverable inside its original session.
pub(super) struct PaneViewer {
    pub(super) stop: Arc<AtomicBool>,
    /// Set to `false` by the reader thread just before it exits. Lets
    /// `spawn()` detect zombie viewers whose PTY has closed.
    pub(super) alive: Arc<AtomicBool>,
    pub(super) writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub(super) master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Captured window id (@...) in the original session.
    pub(super) window_id: String,
    /// Ephemeral grouped view session (clawtab-view-N); killed on stop.
    pub(super) view_session: String,
    /// Monotonic attachment generation for this pane viewer.
    pub(super) attach_generation: u64,
}

/// Where PTY output bytes should be sent.
pub enum OutputSink {
    /// Emit as Tauri event (local desktop xterm.js)
    #[cfg(feature = "desktop")]
    Tauri(AppHandle),
    /// Send via channel (relay forwarding to remote clients)
    Channel(std::sync::mpsc::Sender<(String, Vec<u8>)>),
}

/// Returned from spawn so the frontend knows the pane's native size at capture time.
pub struct SpawnResult {
    pub native_cols: u16,
    pub native_rows: u16,
    pub attach_generation: u64,
}

pub(super) static VIEW_COUNTER: AtomicU64 = AtomicU64::new(0);
pub(super) static ATTACH_COUNTER: AtomicU64 = AtomicU64::new(1);

fn tmux_session_exists(session: &str) -> bool {
    debug_spawn::run_logged(
        "tmux",
        &["has-session", "-t", session],
        "pty::tmux_session_exists",
    )
    .map(|out| out.status.success())
    .unwrap_or(false)
}

pub(super) fn next_view_session_name() -> String {
    loop {
        let view_id = VIEW_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = format!("clawtab-view-{}", view_id);
        if !tmux_session_exists(&candidate) {
            return candidate;
        }
    }
}

pub(super) fn is_view_session(name: &str) -> bool {
    name.starts_with("clawtab-") && name.contains("-view-")
}
