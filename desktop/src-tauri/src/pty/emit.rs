use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(feature = "desktop")]
use tauri::Emitter;

use super::cache::RecentPaneCache;
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

pub(super) fn emit_initial_snapshot(
    sink: &OutputSink,
    recent: &Arc<Mutex<RecentPaneCache>>,
    pane_id: &str,
) {
    let started = Instant::now();
    // Clear the terminal before sending a fresh full-screen snapshot.
    let clear = b"\x1bc".to_vec();
    recent.lock().unwrap().append(pane_id, &clear);
    emit_bytes(sink, pane_id, clear);
    log::debug!(
        "[pty {}] initial snapshot clear emitted after {}ms",
        pane_id,
        started.elapsed().as_millis()
    );

    match crate::tmux::capture_pane_escaped(pane_id) {
        Ok(content) => {
            let bytes = content.into_bytes();
            let byte_len = bytes.len();
            if !bytes.is_empty() {
                recent.lock().unwrap().append(pane_id, &bytes);
                emit_bytes(sink, pane_id, bytes);
            }
            log::info!(
                "[pty {}] initial snapshot capture emitted {} bytes after {}ms",
                pane_id,
                byte_len,
                started.elapsed().as_millis()
            );
        }
        Err(err) => log::warn!(
            "[pty {}] initial snapshot capture failed after {}ms: {}",
            pane_id,
            started.elapsed().as_millis(),
            err
        ),
    }
}

pub(super) fn refresh_attached_pane(
    sink: &OutputSink,
    recent: &Arc<Mutex<RecentPaneCache>>,
    pane_id: &str,
) {
    thread::sleep(Duration::from_millis(150));
    emit_initial_snapshot(sink, recent, pane_id);
}
