use std::time::Instant;

use super::super::capture::resolve_non_view_session_for_window;
use super::super::viewer::is_view_session;

/// Read the pane's native size from tmux. After capture + resize we mutate the
/// pane's size, so this reads the "original" dimensions the user expected
/// before clawtab touched it.
pub(super) fn read_native_size(pane_id: &str, spawn_started: Instant) -> (u16, u16) {
    let (native_cols, native_rows) =
        crate::tmux::display_pane_size(pane_id).unwrap_or((80, 24));
    log::debug!(
        "[pty {}] native size {}x{} read after {}ms",
        pane_id,
        native_cols,
        native_rows,
        spawn_started.elapsed().as_millis()
    );
    (native_cols, native_rows)
}

/// The tmux_session passed by the frontend may be a stale view session (e.g.
/// clawtab-view-39 that was killed). Resolve the real owning session from the
/// pane's current window before passing it to capture_pane, which needs a live
/// session for break-pane.
pub(super) fn resolve_real_session(pane_id: &str, tmux_session: &str) -> String {
    if !is_view_session(tmux_session) && crate::tmux::session_exists(tmux_session) {
        return tmux_session.to_string();
    }
    let window_id_raw = crate::tmux::display_pane_window_id(pane_id).unwrap_or_default();
    let resolved = resolve_non_view_session_for_window(&window_id_raw, tmux_session);
    if resolved != tmux_session {
        log::info!(
            "[pty {}] resolved stale session {} -> {}",
            pane_id,
            tmux_session,
            resolved
        );
    }
    resolved
}
