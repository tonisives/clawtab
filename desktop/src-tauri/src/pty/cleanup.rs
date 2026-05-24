use std::collections::HashMap;

use super::viewer::is_view_session;
use crate::tmux as tmux_api;

/// Sweep orphaned ephemeral view sessions left behind by a previous run.
///
/// View sessions are created via `tmux new-session -t base`, which puts them
/// in a session group sharing windows with the base. `kill-session` only kills
/// the named session — the base and its windows survive as long as another
/// group member exists. To guard the edge case where a real session ends up
/// with its group name set to a view (e.g. base was created *from* the view),
/// we skip any view session that is the *only* remaining member of its group.
pub(super) fn cleanup_orphaned_view_sessions(keep: &[&str]) {
    let raw = match tmux_api::list_sessions_with_groups() {
        Ok(v) => v,
        Err(e) => {
            log::debug!(
                "cleanup_orphaned_view_sessions: list-sessions failed: {}",
                e
            );
            return;
        }
    };

    // group -> list of member session names. Sessions with no group list
    // themselves under their own name so the "last member" check still works.
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    let mut view_sessions: Vec<(String, String)> = Vec::new();
    for line in raw.lines() {
        let mut parts = line.splitn(2, '\x1e');
        let name = parts.next().unwrap_or("").to_string();
        let group = parts.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let group_key = if group.is_empty() {
            name.clone()
        } else {
            group
        };
        members
            .entry(group_key.clone())
            .or_default()
            .push(name.clone());
        if is_view_session(&name) {
            view_sessions.push((name, group_key));
        }
    }

    let keep: std::collections::HashSet<&str> = keep.iter().copied().collect();
    let mut killed = 0usize;
    let mut skipped_last = 0usize;
    for (name, group_key) in view_sessions {
        if keep.contains(name.as_str()) {
            continue;
        }
        let group_members = members.get(&group_key);
        let has_non_view_member = group_members
            .map(|m| m.iter().any(|n| !is_view_session(n)))
            .unwrap_or(false);
        if !has_non_view_member {
            log::warn!(
                "cleanup_orphaned_view_sessions: skipping {} — last member of group {}",
                name,
                group_key
            );
            skipped_last += 1;
            continue;
        }
        match tmux_api::kill_session(&name) {
            Ok(_) => killed += 1,
            Err(e) => log::debug!(
                "cleanup_orphaned_view_sessions: kill {} failed: {}",
                name,
                e
            ),
        }
    }

    if killed > 0 || skipped_last > 0 {
        log::info!(
            "cleanup_orphaned_view_sessions: killed {}, skipped {} (last member of group)",
            killed,
            skipped_last
        );
    }
}

fn is_idle_shell_command(cmd: &str) -> bool {
    matches!(
        cmd,
        "zsh" | "bash" | "sh" | "fish" | "dash" | "ksh" | "tcsh"
    )
}

/// Sweep `ct-*` windows whose only process is an idle shell. Leaves windows
/// running real processes (codex, opencode, agents, editors, ...) alone so
/// they can be released manually via the app UI.
///
/// These orphans accumulate when the app crashes or force-quits while a pane
/// viewer is open: the view session dies (or gets swept), but the captured
/// `ct-*` window parks in its base session with no tab pointing at it.
///
/// `protected_panes` names pane IDs currently open in ClawTab's UI -- any
/// window containing such a pane is skipped even if it looks idle.
struct WindowEntry {
    session: String,
    window_id: String,
    window_name: String,
    panes: Vec<(String, String)>,
}

pub(super) fn cleanup_orphaned_ct_windows(protected_panes: &std::collections::HashSet<String>) {
    let raw = match tmux_api::list_panes_all_with_commands() {
        Ok(v) => v,
        Err(e) => {
            log::debug!("cleanup_orphaned_ct_windows: list-panes failed: {}", e);
            return;
        }
    };

    let windows = group_ct_windows(&raw);

    let mut killed = 0usize;
    let mut kept = 0usize;
    for (_, entry) in windows {
        if try_kill_or_keep(&entry, protected_panes, &mut killed, &mut kept) {
            // counted by callee
        }
    }

    if killed > 0 || kept > 0 {
        log::info!(
            "cleanup_orphaned_ct_windows: killed {} idle, kept {} live",
            killed,
            kept
        );
    }
}

/// Group ct- windows by window_id, skipping non-ct windows and view-session
/// duplicates. list-panes -a reports the same window under every session-group
/// member; we want each window once under its real (non-view) session.
fn group_ct_windows(raw: &str) -> std::collections::HashMap<String, WindowEntry> {
    let mut windows: std::collections::HashMap<String, WindowEntry> =
        std::collections::HashMap::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\x1e').collect();
        if parts.len() < 5 {
            continue;
        }
        let session = parts[0];
        let window_id = parts[1];
        let window_name = parts[2];
        let pane_id = parts[3];
        let cmd = parts[4];

        if !window_name.starts_with("ct-") || is_view_session(session) {
            continue;
        }

        let entry = windows
            .entry(window_id.to_string())
            .or_insert_with(|| WindowEntry {
                session: session.to_string(),
                window_id: window_id.to_string(),
                window_name: window_name.to_string(),
                panes: Vec::new(),
            });
        entry.panes.push((pane_id.to_string(), cmd.to_string()));
    }
    windows
}

fn try_kill_or_keep(
    entry: &WindowEntry,
    protected_panes: &std::collections::HashSet<String>,
    killed: &mut usize,
    kept: &mut usize,
) -> bool {
    let has_protected = entry
        .panes
        .iter()
        .any(|(pane_id, _)| protected_panes.contains(pane_id));
    if has_protected {
        log::info!(
            "cleanup_orphaned_ct_windows: keeping {} ({}:{}) - pane open in ClawTab",
            entry.window_name,
            entry.session,
            entry.window_id
        );
        *kept += 1;
        return false;
    }

    let all_idle = entry
        .panes
        .iter()
        .all(|(_, cmd)| is_idle_shell_command(cmd));
    if !all_idle {
        log::info!(
            "cleanup_orphaned_ct_windows: keeping {} ({}:{}) running",
            entry.window_name,
            entry.session,
            entry.window_id,
        );
        *kept += 1;
        return false;
    }

    match tmux_api::kill_window_by_id(&entry.window_id) {
        Ok(_) => {
            log::info!(
                "cleanup_orphaned_ct_windows: killed {} ({}:{}) idle",
                entry.window_name,
                entry.session,
                entry.window_id,
            );
            *killed += 1;
            true
        }
        Err(e) => {
            log::debug!(
                "cleanup_orphaned_ct_windows: kill {} failed: {}",
                entry.window_id,
                e
            );
            false
        }
    }
}
