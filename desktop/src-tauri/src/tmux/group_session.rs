use std::path::{Path, PathBuf};

use crate::agent_session::{detect_process_provider, ProcessSnapshot};

use super::{is_view_session, run_capture};

struct GroupPane<'a> {
    session: &'a str,
    id: u64,
    cwd: &'a str,
    pid: &'a str,
}

fn canonical_dir(dir: &str) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| PathBuf::from(dir))
}

fn select_session<'a>(
    snapshot: &'a str,
    cwd: &str,
    is_agent: impl Fn(&str) -> bool,
) -> Option<&'a str> {
    if cwd.is_empty() {
        return None;
    }
    let root = canonical_dir(cwd);
    snapshot
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split('\x1e').collect();
            if fields.len() != 4 || fields[0].is_empty() || is_view_session(fields[0]) {
                return None;
            }
            Some(GroupPane {
                session: fields[0],
                id: fields[1].strip_prefix('%')?.parse().ok()?,
                cwd: fields[2],
                pid: fields[3],
            })
        })
        .filter(|pane| {
            Path::new(pane.cwd).starts_with(&root) || canonical_dir(pane.cwd).starts_with(&root)
        })
        // Pane IDs increase within a tmux server. Prefer the newest agent;
        // a matching shell/editor is useful when no agent remains in the group.
        .max_by_key(|pane| (is_agent(pane.pid), pane.id))
        .map(|pane| pane.session)
}

/// Find the session that most recently hosted this group's live panes.
/// Query all sessions once and share one process snapshot across candidates.
pub fn find_group_session(cwd: &str) -> Option<String> {
    let panes = run_capture(
        &[
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\x1e#{pane_id}\x1e#{pane_current_path}\x1e#{pane_pid}",
        ],
        "tmux::group_session::list_panes",
    )
    .ok()?;
    let processes = ProcessSnapshot::capture();
    select_session(&panes, cwd, |pid| {
        detect_process_provider(pid, Some(&processes)).is_some()
    })
    .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(session: &str, pane: &str, cwd: &str, pid: &str) -> String {
        [session, pane, cwd, pid].join("\x1e")
    }

    #[test]
    fn uses_newest_agent_across_sessions_ignoring_newer_editors_and_other_groups() {
        let panes = [
            row("tgs", "%10", "/projects/eth-job-rs", "agent"),
            row("wrk", "%20", "/projects/eth-job-rs/.worktrees/fix", "agent"),
            row("tgs", "%30", "/projects/eth-job-rs", "editor"),
            row("tgs", "%40", "/projects/eth-job-rs-other", "agent"),
            row("tgs", "%50", "/elsewhere/eth-job-rs", "agent"),
            row("clawtab-view-1", "%60", "/projects/eth-job-rs", "agent"),
        ]
        .join("\n");
        assert_eq!(
            select_session(&panes, "/projects/eth-job-rs/", |pid| pid == "agent"),
            Some("wrk")
        );
    }

    #[test]
    fn falls_back_to_matching_panes_then_default_when_group_is_absent() {
        let panes = [
            row("tgs", "%1", "/projects/app", "shell"),
            row("wrk", "%2", "/projects/app", "editor"),
            "malformed".to_string(),
        ]
        .join("\n");
        assert_eq!(
            select_session(&panes, "/projects/app", |_| false),
            Some("wrk")
        );
        assert_eq!(select_session(&panes, "/projects/unknown", |_| true), None);
        assert_eq!(select_session(&panes, "", |_| true), None);
    }
}
