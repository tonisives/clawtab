use std::time::Instant;

use super::super::viewer::next_view_session_name;

/// Create an ephemeral session linked only to the requested window, so a
/// closed agent cannot redirect its terminal to a different pane.
pub(super) fn create_view_session(
    pane_id: &str,
    _base_session: &str,
    window_id: &str,
    spawn_started: Instant,
) -> Result<String, String> {
    let view_session = next_view_session_name();
    crate::tmux::new_window_view_session(&view_session, window_id).map_err(|e| {
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

#[cfg(test)]
mod tests {
    use crate::pty::{OutputSink, PtyManager};

    #[test]
    #[ignore = "requires an isolated tmux wrapper and CLAWTAB_PTY_TEST_SOCKET"]
    fn viewer_never_switches_to_another_window_after_its_pane_closes() {
        let socket = std::env::var("CLAWTAB_PTY_TEST_SOCKET").unwrap();
        assert!(socket.starts_with("clawtab-pty-test-"));
        let actual = std::process::Command::new("tmux")
            .args(["display-message", "-p", "#{socket_path}"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&actual.stdout)
            .trim()
            .ends_with(&socket));

        let mut manager = PtyManager::new();
        let base = "pty-test-base";
        crate::tmux::new_session_with_placeholder(base).unwrap();
        let pane = crate::tmux::create_window_with_cwd(base, "agent", None, &[]).unwrap();
        let window = crate::tmux::display_pane_window_id(&pane).unwrap();
        let (tx, _rx) = std::sync::mpsc::sync_channel(64);
        manager
            .spawn(
                &pane,
                base,
                80,
                24,
                "default",
                OutputSink::Channel(tx.clone()),
            )
            .unwrap();
        let view = manager.sessions.get(&pane).unwrap().view_session.clone();
        let unrelated = crate::tmux::create_window_with_cwd(base, "unrelated", None, &[]).unwrap();
        let windows: Vec<_> = crate::tmux::list_all_windows_with_session()
            .unwrap()
            .into_iter()
            .filter(|(session, _)| session == &view)
            .map(|(_, window)| window)
            .collect();
        assert_eq!(windows, vec![window]);

        crate::tmux::kill_pane(&pane).unwrap();
        assert!(!crate::tmux::session_exists(&view));
        assert!(crate::tmux::pane_exists(&unrelated));
        assert!(manager
            .spawn(&pane, base, 80, 24, "default", OutputSink::Channel(tx))
            .is_err());
        crate::tmux::kill_session(base).unwrap();
    }
}
