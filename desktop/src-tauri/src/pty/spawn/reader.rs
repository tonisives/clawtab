use parking_lot::Mutex;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
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
    reader: Box<dyn Read + Send>,
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
        spawn_read_pump(reader, Arc::clone(&stop_clone), output_tx);
        run_emit_loop(EmitLoop {
            output_rx,
            stop: stop_clone,
            sink,
            recent,
            pane_id: pane_id_for_thread,
            event_key,
            alive_flag,
        });
    });
}

struct EmitLoop {
    output_rx: mpsc::Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
    sink: OutputSink,
    recent: Arc<Mutex<RecentPaneCache>>,
    pane_id: String,
    event_key: String,
    alive_flag: Arc<AtomicBool>,
}

/// Inner thread: drain the PTY reader and forward chunks to the emit loop.
/// Exits on EOF, read error, channel disconnect, or `stop`.
fn spawn_read_pump(
    mut reader: Box<dyn Read + Send>,
    stop: Arc<AtomicBool>,
    output_tx: mpsc::Sender<Vec<u8>>,
) {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            if stop.load(Ordering::Relaxed) {
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
}

fn flush_pending(
    pending: &mut Vec<u8>,
    recent: &Arc<Mutex<RecentPaneCache>>,
    pane_id: &str,
    event_key: &str,
    sink: &OutputSink,
) {
    if pending.is_empty() {
        return;
    }
    let bytes = std::mem::take(pending);
    recent.lock().append(pane_id, &bytes);
    match sink {
        #[cfg(feature = "desktop")]
        OutputSink::Tauri(app_handle) => {
            let _ = app_handle.emit(&format!("pty-output-{}", event_key), bytes);
        }
        OutputSink::Channel(tx) => {
            let _ = tx.send((pane_id.to_string(), bytes));
        }
    }
    let _ = event_key;
}

fn emit_exit(sink: &OutputSink, event_key: &str) {
    match sink {
        #[cfg(feature = "desktop")]
        OutputSink::Tauri(app_handle) => {
            let _ = app_handle.emit(&format!("pty-exit-{}", event_key), ());
        }
        OutputSink::Channel(_) => {}
    }
    let _ = event_key;
}

fn run_emit_loop(ctx: EmitLoop) {
    let EmitLoop {
        output_rx,
        stop,
        sink,
        recent,
        pane_id,
        event_key,
        alive_flag,
    } = ctx;
    let mut pending: Vec<u8> = Vec::new();
    let batch_window = Duration::from_millis(PTY_EMIT_BATCH_MS);
    let idle_poll = Duration::from_millis(250);
    let mut flush_deadline: Option<Instant> = None;

    loop {
        if stop.load(Ordering::Relaxed) {
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
                    flush_pending(&mut pending, &recent, &pane_id, &event_key, &sink);
                    flush_deadline = None;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                flush_pending(&mut pending, &recent, &pane_id, &event_key, &sink);
                flush_deadline = None;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if !pending.is_empty() {
                    flush_pending(&mut pending, &recent, &pane_id, &event_key, &sink);
                }
                break;
            }
        }
    }
    flush_pending(&mut pending, &recent, &pane_id, &event_key, &sink);
    alive_flag.store(false, Ordering::Relaxed);
    emit_exit(&sink, &event_key);
    log::info!("[pty {}] reader thread exited", event_key);
}
