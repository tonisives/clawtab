#[cfg(feature = "desktop")]
use tauri::Emitter;

use super::viewer::OutputSink;

pub(super) const PTY_EMIT_BATCH_MS: u64 = 16;
pub(super) const PTY_EMIT_MAX_BYTES: usize = 32 * 1024;

pub(super) fn emit_bytes(sink: &OutputSink, pane_id: &str, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }

    match sink {
        #[cfg(feature = "desktop")]
        OutputSink::Tauri(app_handle) => {
            let _ = app_handle.emit(&format!("pty-output-{}", pane_id.replace('%', "p")), bytes);
        }
        OutputSink::Channel(tx) => {
            let _ = tx.send((pane_id.to_string(), bytes));
        }
    }
}

/// Redraw through the attached client so cursor positions, modes and output
/// ordering stay owned by tmux. A capture-pane dump cannot replace this stream.
pub(super) fn refresh_attached_pane(view_session: &str) -> Result<(), String> {
    crate::tmux::refresh_session_clients(view_session)
}
