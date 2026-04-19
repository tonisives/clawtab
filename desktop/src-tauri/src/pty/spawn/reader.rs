use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(feature = "desktop")]
use tauri::Emitter;

use super::super::cache::RecentPaneCache;
use super::super::emit::{PTY_EMIT_BATCH_MS, PTY_EMIT_MAX_BYTES};
use super::super::viewer::OutputSink;

/// Spawn the two-thread batched read+emit loop that drains the PTY reader and
/// forwards output to the sink in batched chunks. `alive_flag` flips to false
/// when the reader exits so callers can detect a dead viewer.
pub(super) fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    stop: Arc<AtomicBool>,
    alive_flag: Arc<AtomicBool>,
    pane_id: &str,
    sink: OutputSink,
    recent: Arc<Mutex<RecentPaneCache>>,
) {
    let event_key = pane_id.replace('%', "p");
    let pane_id_for_thread = pane_id.to_string();
    let stop_clone = Arc::clone(&stop);

    thread::spawn(move || {
        let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>();
        let reader_stop = Arc::clone(&stop_clone);

        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                if reader_stop.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output_tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut pending = Vec::new();
        let batch_window = Duration::from_millis(PTY_EMIT_BATCH_MS);
        let idle_poll = Duration::from_millis(250);
        let mut flush_deadline: Option<Instant> = None;

        let flush_pending = |pending: &mut Vec<u8>| {
            if pending.is_empty() {
                return;
            }
            let bytes = std::mem::take(pending);
            recent.lock().unwrap().append(&pane_id_for_thread, &bytes);
            match &sink {
                #[cfg(feature = "desktop")]
                OutputSink::Tauri(app_handle) => {
                    let _ = app_handle.emit(&format!("pty-output-{}", event_key), bytes);
                }
                OutputSink::Channel(tx) => {
                    let _ = tx.send((pane_id_for_thread.clone(), bytes));
                }
            }
        };

        loop {
            if stop_clone.load(Ordering::Relaxed) {
                break;
            }
            let timeout = flush_deadline
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or(idle_poll);
            match output_rx.recv_timeout(timeout) {
                Ok(bytes) => {
                    if pending.is_empty() {
                        flush_deadline = Some(Instant::now() + batch_window);
                    }
                    pending.extend_from_slice(&bytes);
                    if pending.len() >= PTY_EMIT_MAX_BYTES {
                        flush_pending(&mut pending);
                        flush_deadline = None;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    flush_pending(&mut pending);
                    flush_deadline = None;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !pending.is_empty() {
                        flush_pending(&mut pending);
                    }
                    break;
                }
            }
        }
        flush_pending(&mut pending);
        alive_flag.store(false, Ordering::Relaxed);
        match &sink {
            #[cfg(feature = "desktop")]
            OutputSink::Tauri(app_handle) => {
                let _ = app_handle.emit(&format!("pty-exit-{}", event_key), ());
            }
            OutputSink::Channel(_) => {}
        }
        log::info!("[pty {}] reader thread exited", event_key);
    });
}
