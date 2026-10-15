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
        OutputSink::Channel(tx) | OutputSink::Relay(tx, _) => {
            let _ = tx.send((pane_id.to_string(), bytes));
        }
    }
}

pub(super) fn emit_control(sink: &OutputSink, pane: &str, snapshot: &crate::managed::Snapshot) {
    let event = serde_json::json!({"type":"terminal_control","pane_id":pane,"controller":snapshot.control.holder,"control_epoch":snapshot.control.epoch,"cols":snapshot.size.cols,"rows":snapshot.size.rows});
    match sink {
        OutputSink::Relay(_, relay) => {
            if let Some(relay) = relay.lock().as_ref() {
                let _ = relay.send_raw(event.to_string());
            }
        }
        #[cfg(feature = "desktop")]
        OutputSink::Tauri(app) => {
            let _ = app.emit(&format!("terminal-control-{pane}"), event);
        }
        _ => {}
    }
}

/// Redraw through the attached client so cursor positions, modes and output
/// ordering stay owned by tmux. A capture-pane dump cannot replace this stream.
pub(super) fn refresh_attached_pane(view_session: &str) -> Result<(), String> {
    crate::terminal_backend::refresh_session_clients(view_session)
}

pub(super) fn emit_exit(sink: &OutputSink, pane: &str) {
    match sink {
        OutputSink::Relay(_, relay) => {
            if let Some(relay) = relay.lock().as_ref() {
                let _ = relay
                    .send_raw(serde_json::json!({"type":"pty_exit","pane_id":pane}).to_string());
            }
        }
        #[cfg(feature = "desktop")]
        OutputSink::Tauri(app) => {
            let _ = app.emit(&format!("pty-exit-{}", pane.replace('%', "p")), ());
        }
        _ => {}
    }
}
