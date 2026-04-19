use std::time::Instant;

use super::super::viewer::next_view_session_name;

/// Create an ephemeral grouped view session so this viewer has its own
/// current-window without disturbing other clients attached to the original
/// session. Selects `window_id` inside the new session and hides its status
/// bar. Cleans up the new session on select-window failure.
pub(super) fn create_view_session(
    pane_id: &str,
    base_session: &str,
    window_id: &str,
    spawn_started: Instant,
) -> Result<String, String> {
    let view_session = next_view_session_name();
    crate::tmux::new_grouped_view_session(&view_session, base_session).map_err(|e| {
        log::warn!(
            "[pty {}] new-session failed after {}ms: {}",
            pane_id,
            spawn_started.elapsed().as_millis(),
            e
        );
        e
    })?;
    let _ = crate::tmux::set_session_status_off(&view_session);
    crate::tmux::select_window(&format!("{}:{}", view_session, window_id)).map_err(|e| {
        log::warn!(
            "[pty {}] select-window failed after {}ms: {}",
            pane_id,
            spawn_started.elapsed().as_millis(),
            e
        );
        let _ = crate::tmux::kill_session(&view_session);
        e
    })?;
    log::info!(
        "[pty {}] view session {} ready after {}ms",
        pane_id,
        view_session,
        spawn_started.elapsed().as_millis()
    );
    Ok(view_session)
}
