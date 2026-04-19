mod attach;
mod prepare;
mod reader;
mod reuse;
mod view_session;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use super::capture::capture_pane;
use super::emit::refresh_attached_pane;
use super::viewer::{OutputSink, PaneViewer, SpawnResult, ATTACH_COUNTER};
use super::PtyManager;

/// Orchestrate the full spawn flow: reuse existing viewer if alive, otherwise
/// capture the pane, create a view session, attach a PTY, wire up the reader
/// thread, and register a fresh `PaneViewer`.
pub(super) fn run(
    manager: &mut PtyManager,
    pane_id: &str,
    tmux_session: &str,
    cols: u16,
    rows: u16,
    sink: OutputSink,
) -> Result<SpawnResult, String> {
    let spawn_started = Instant::now();
    log::info!(
        "[pty {}] spawn start session={} size={}x{}",
        pane_id,
        tmux_session,
        cols,
        rows
    );

    reuse::reap_dead_viewer(manager, pane_id);
    if let Some(result) =
        reuse::try_reuse_existing_viewer(manager, pane_id, cols, rows, &sink, spawn_started)?
    {
        return Ok(result);
    }

    let (native_cols, native_rows) = prepare::read_native_size(pane_id, spawn_started);
    let tmux_session = prepare::resolve_real_session(pane_id, tmux_session);

    let (base_session, window_id) = capture_pane(pane_id, &tmux_session).map_err(|e| {
        log::warn!(
            "[pty {}] capture_pane failed after {}ms: {}",
            pane_id,
            spawn_started.elapsed().as_millis(),
            e
        );
        e
    })?;
    log::info!(
        "[pty {}] captured base_session={} window_id={} after {}ms",
        pane_id,
        base_session,
        window_id,
        spawn_started.elapsed().as_millis()
    );

    let view_session =
        view_session::create_view_session(pane_id, &base_session, &window_id, spawn_started)?;

    let attached = attach::open_pty_and_attach(pane_id, &view_session, cols, rows, spawn_started)?;

    let stop = Arc::new(AtomicBool::new(false));
    let alive_flag = Arc::new(AtomicBool::new(true));
    let attach_generation = ATTACH_COUNTER.fetch_add(1, Ordering::Relaxed);

    // Resize the captured window to match the viewport so content reflows.
    if cols > 0 && rows > 0 {
        let _ = crate::tmux::resize_window(&window_id, cols, rows);
    }

    // Let attach-session settle, then push a full snapshot and force redraw.
    refresh_attached_pane(&sink, &manager.recent, pane_id);
    log::info!(
        "[pty {}] initial refresh done after {}ms",
        pane_id,
        spawn_started.elapsed().as_millis()
    );

    reader::spawn_reader_thread(
        attached.reader,
        Arc::clone(&stop),
        Arc::clone(&alive_flag),
        pane_id,
        sink,
        Arc::clone(&manager.recent),
    );

    manager.sessions.insert(
        pane_id.to_string(),
        PaneViewer {
            stop,
            alive: alive_flag,
            writer: attached.writer,
            master: attached.master,
            window_id,
            view_session,
            attach_generation,
        },
    );

    let result = SpawnResult {
        native_cols,
        native_rows,
        attach_generation,
    };
    log::info!(
        "[pty {}] spawn complete generation={} after {}ms",
        pane_id,
        attach_generation,
        spawn_started.elapsed().as_millis()
    );
    Ok(result)
}
