use super::viewer::is_view_session;
use crate::tmux as tmux_api;

pub(super) fn resolve_non_view_session_for_window(window_id: &str, fallback: &str) -> String {
    let rows = match tmux_api::list_all_windows_with_session() {
        Ok(v) => v,
        Err(_) => return fallback.to_string(),
    };
    for (session, wid) in rows {
        if wid == window_id && !is_view_session(&session) {
            return session;
        }
    }
    fallback.to_string()
}

/// Returns Some((session, window_id)) if the pane is already in a ct-* window
/// (i.e. already captured by clawtab).
pub(super) fn find_captured_window(pane_id: &str) -> Option<(String, String)> {
    let info = tmux_api::display_pane_origin(pane_id).ok()?;
    if info.window_name.starts_with("ct-") {
        let session = resolve_non_view_session_for_window(&info.window_id, &info.session);
        Some((session, info.window_id))
    } else {
        None
    }
}

/// Return the next available `ct-<base>-<N>` window name in `session`.
/// Starts at 1 and picks the smallest unused integer suffix.
fn next_ct_window_name(session: &str, base: &str) -> String {
    let base = if base.is_empty() { "pane" } else { base };
    let existing = tmux_api::list_window_names_in_session(session).unwrap_or_default();
    let prefix = format!("ct-{}-", base);
    let mut used = std::collections::HashSet::new();
    for name in existing {
        if let Some(rest) = name.strip_prefix(&prefix) {
            if let Ok(n) = rest.parse::<u32>() {
                used.insert(n);
            }
        }
    }
    let mut n = 1u32;
    while used.contains(&n) {
        n += 1;
    }
    format!("ct-{}-{}", base, n)
}

/// Break a pane into a new `ct-<orig_window_name>-<N>` window inside the pane's
/// original tmux session. Records origin as a window option so release can put
/// it back. Returns (session, window_id). Idempotent: if already captured,
/// returns the existing session/window.
///
/// `tmux_session` MUST be the real owning session of the pane, supplied by the
/// caller. Do NOT trust `#{session_name}` from `display-message -t %pane_id`:
/// when a pane's window is shared across a session group, tmux resolves the
/// pane target to whichever group member it feels like (often the most recent
/// ephemeral `clawtab-view-N`), recording a dead view session as the origin.
///
/// IMPORTANT: targets use the raw `%pane_id` form, NOT `session:%pane_id`.
/// In tmux, `session:target` interprets `target` as a window reference — when
/// target starts with `%`, tmux treats it as the active pane of the session,
/// NOT the pane with that ID. Pane IDs are globally unique, so the session
/// prefix adds nothing here and actively breaks pane lookup.
pub(super) fn capture_pane(pane_id: &str, tmux_session: &str) -> Result<(String, String), String> {
    if let Some((existing_sess, existing_win)) = find_captured_window(pane_id) {
        let pane_count = tmux_api::display_window_pane_count(&existing_win)?;
        if pane_count <= 1 {
            return Ok((existing_sess, existing_win));
        }

        // Origin session from @clawtab-origin is authoritative. See the big
        // comment below about why #{session_name} is unreliable here.
        let origin_meta_raw = tmux_api::get_window_origin(&existing_win).unwrap_or_default();
        let origin_parts: Vec<&str> = origin_meta_raw.split('\t').collect();
        let origin_session = origin_parts.first().copied().unwrap_or(tmux_session);
        let origin_window_id = origin_parts.get(1).copied().unwrap_or("");
        let origin_pane_index = origin_parts.get(2).copied().unwrap_or("0");
        let origin_window_name = origin_parts.get(3).copied().unwrap_or("pane");

        let new_name = next_ct_window_name(origin_session, origin_window_name);
        tmux_api::break_pane_detached(pane_id, origin_session, &new_name)?;

        let new_win = tmux_api::display_pane_window_id(pane_id)?;

        let origin_meta = format!(
            "{}\t{}\t{}\t{}",
            origin_session, origin_window_id, origin_pane_index, origin_window_name
        );
        let _ = tmux_api::set_window_origin(&new_win, &origin_meta);

        return Ok((origin_session.to_string(), new_win));
    }

    let origin = tmux_api::display_pane_origin_full(pane_id)?;
    let orig_window_id = origin.window_id;
    let orig_pane_index = origin.pane_index;
    let orig_window_name = origin.window_name;
    let orig_window_panes = origin.window_panes;

    let new_name = next_ct_window_name(tmux_session, &orig_window_name);

    // If the pane is already alone in its window, skip break-pane and just
    // rename the window. This avoids the "sessions are grouped" error when
    // the target session is part of a session group (e.g. because a view
    // session is attached to it).
    let new_win = if orig_window_panes <= 1 {
        tmux_api::rename_window(&orig_window_id, &new_name)?;
        orig_window_id.clone()
    } else {
        tmux_api::break_pane_detached(pane_id, tmux_session, &new_name)?;
        tmux_api::display_pane_window_id(pane_id)?
    };

    // Origin metadata: session\twindow_id\tpane_index\twindow_name (matches the
    // format release_captured_pane expects).
    let origin_meta = format!(
        "{}\t{}\t{}\t{}",
        tmux_session, orig_window_id, orig_pane_index, orig_window_name
    );
    let _ = tmux_api::set_window_origin(&new_win, &origin_meta);

    Ok((tmux_session.to_string(), new_win))
}

/// Release a captured pane back to its original session:window.
///
/// If the original window still exists in the original session, the pane is
/// joined back into it. If the original window is gone (because the pane was
/// the last one in it when captured, and break-pane migrated the window_id),
/// a new window with the original name is created in the original session.
/// If the original session is also gone, a new session with the original name
/// is created.
pub(super) fn release_captured_pane(pane_id: &str) -> Result<(), String> {
    let (_, _cap_win) = find_captured_window(pane_id).ok_or("pane is not captured")?;

    // Read origin from the current (captured) window of the pane.
    let cap_win_now = tmux_api::display_pane_window_id(pane_id)?;
    let origin = tmux_api::get_window_origin(&cap_win_now)
        .map_err(|e| format!("no origin recorded: {}", e))?;

    let parts: Vec<&str> = origin.split('\t').collect();
    if parts.len() < 2 {
        return Err(format!("malformed origin: {}", origin));
    }
    let orig_session = parts[0];
    let orig_window = parts[1];
    let orig_window_name = parts.get(3).copied().unwrap_or("");

    if !tmux_api::session_exists(orig_session) {
        tmux_api::new_session_with_placeholder(orig_session)?;
        let name = if orig_window_name.is_empty() {
            "restored"
        } else {
            orig_window_name
        };
        tmux_api::break_pane_detached(pane_id, orig_session, name)?;
        let _ = tmux_api::kill_window(orig_session, "__tmp");
        return Ok(());
    }

    // Does the original window still belong to the original session?
    // Note: @window_id is globally unique in tmux, but `display-message -t session:@id`
    // resolves the window_id globally and ignores the session prefix. So we have to
    // check session membership explicitly by listing the windows of orig_session.
    let windows_in_session = tmux_api::list_window_ids_in_session(orig_session).unwrap_or_default();
    let window_exists = windows_in_session.iter().any(|l| l == orig_window);

    if window_exists {
        tmux_api::join_pane(pane_id, orig_window)?;
        if !orig_window_name.is_empty() {
            let _ = tmux_api::rename_window(orig_window, orig_window_name);
        }
    } else {
        let name = if orig_window_name.is_empty() {
            "restored"
        } else {
            orig_window_name
        };
        tmux_api::break_pane_detached(pane_id, orig_session, name)?;
    }

    Ok(())
}
