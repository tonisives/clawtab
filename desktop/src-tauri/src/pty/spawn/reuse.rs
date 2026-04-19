use std::sync::atomic::Ordering;
use std::time::Instant;

use super::super::emit::refresh_attached_pane;
use super::super::viewer::{ATTACH_COUNTER, OutputSink, SpawnResult};
use super::super::PtyManager;

/// If a dead viewer is parked on `pane_id` (reader thread has exited), tear it
/// down so the caller can fall through to a fresh spawn.
pub(super) fn reap_dead_viewer(manager: &mut PtyManager, pane_id: &str) {
    let is_dead = manager
        .sessions
        .get(pane_id)
        .is_some_and(|v| !v.alive.load(Ordering::Relaxed));
    if !is_dead {
        return;
    }
    log::info!(
        "[pty {}] existing viewer is dead, removing for fresh spawn",
        pane_id
    );
    if let Some(dead) = manager.sessions.remove(pane_id) {
        dead.stop.store(true, Ordering::Relaxed);
        let _ = crate::tmux::kill_session(&dead.view_session);
    }
}

/// If a live viewer already exists for this pane, reuse it: bump its attach
/// generation, resize to the new viewport, and push a fresh snapshot. Returns
/// Some(SpawnResult) when reuse succeeded, None when the caller should fall
/// through to the full spawn path.
pub(super) fn try_reuse_existing_viewer(
    manager: &mut PtyManager,
    pane_id: &str,
    cols: u16,
    rows: u16,
    sink: &OutputSink,
    spawn_started: Instant,
) -> Result<Option<SpawnResult>, String> {
    if !manager.sessions.contains_key(pane_id) {
        return Ok(None);
    }

    let attach_generation = ATTACH_COUNTER.fetch_add(1, Ordering::Relaxed);
    if let Some(viewer) = manager.sessions.get_mut(pane_id) {
        viewer.attach_generation = attach_generation;
    }
    manager.resize(pane_id, cols, rows)?;
    log::info!(
        "[pty {}] reused existing viewer generation={} resized after {}ms",
        pane_id,
        attach_generation,
        spawn_started.elapsed().as_millis()
    );
    refresh_attached_pane(sink, &manager.recent, pane_id);

    let (native_cols, native_rows) = crate::tmux::display_pane_size(pane_id)?;
    let result = SpawnResult {
        native_cols,
        native_rows,
        attach_generation,
    };
    log::debug!(
        "[pty {}] reused existing viewer spawn complete after {}ms native={}x{}",
        pane_id,
        spawn_started.elapsed().as_millis(),
        result.native_cols,
        result.native_rows
    );
    Ok(Some(result))
}
