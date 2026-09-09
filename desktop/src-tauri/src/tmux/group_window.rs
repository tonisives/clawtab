use sha2::{Digest, Sha256};
use std::path::Path;

use super::{
    create_session, create_window_with_cwd, is_view_session, run_capture, run_ok, session_exists,
};

struct GroupPane<'a> {
    session: &'a str,
    window: &'a str,
    pane: &'a str,
    cwd: &'a str,
    remembered: u64,
    origin: &'a str,
}

fn parse_panes(snapshot: &str) -> Vec<GroupPane<'_>> {
    snapshot
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split('\x1e').collect();
            if fields.len() != 6 || is_view_session(fields[0]) {
                return None;
            }
            Some(GroupPane {
                session: fields[0],
                window: fields[1],
                pane: fields[2],
                cwd: fields[3],
                remembered: fields[4].parse().unwrap_or(0),
                origin: fields[5],
            })
        })
        .collect()
}

/// Pane IDs increase within a tmux server, so the newest matching pane is a
/// cheap recency signal. A window option preserves that score after it exits.
/// Follow captured panes back to their real window, never into a viewer window.
fn select_group_window<'a>(panes: &'a [GroupPane<'a>], cwd: &str) -> Option<(&'a str, &'a str)> {
    panes
        .iter()
        .filter_map(|pane| {
            let matches_dir = !cwd.is_empty() && Path::new(pane.cwd).starts_with(cwd);
            let score = if matches_dir {
                pane.pane
                    .strip_prefix('%')?
                    .parse::<u64>()
                    .ok()?
                    .saturating_add(1)
            } else {
                0
            }
            .max(pane.remembered);
            if score == 0 {
                return None;
            }
            let target = if pane.origin.is_empty() {
                (pane.session, pane.window)
            } else {
                let (session, rest) = pane.origin.split_once('\t')?;
                let window = rest.split('\t').next()?;
                // The original window must still exist in its recorded session.
                panes
                    .iter()
                    .find(|candidate| candidate.session == session && candidate.window == window)?;
                (session, window)
            };
            Some(((score, matches_dir), target))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, target)| target)
}

pub fn create_group_agent_pane(
    default_session: &str,
    name: &str,
    cwd: &str,
    env_vars: &[(String, String)],
) -> Result<(String, String), String> {
    let canonical = std::fs::canonicalize(cwd).ok();
    let group_dir = canonical
        .as_deref()
        .unwrap_or_else(|| Path::new(cwd))
        .to_string_lossy();
    // Hash the full path: equal folder names in different projects stay separate.
    let option = format!("@clawtab-group-{:x}", Sha256::digest(group_dir.as_bytes()));
    let format = format!("#{{session_name}}\x1e#{{window_id}}\x1e#{{pane_id}}\x1e#{{pane_current_path}}\x1e#{{{option}}}\x1e#{{@clawtab-origin}}");
    let snapshot = run_capture(
        &["list-panes", "-a", "-F", &format],
        "tmux::group_window::list_panes",
    )
    .unwrap_or_default();
    let panes = parse_panes(&snapshot);
    if let Some((session, window)) = select_group_window(&panes, &group_dir) {
        match split_group_window(window, cwd, env_vars) {
            Ok(pane) => {
                remember_window(window, &option, &pane);
                return Ok((session.to_string(), pane));
            }
            Err(error) => log::debug!("Could not reuse group window: {error}"),
        }
    }

    if !session_exists(default_session) {
        create_session(default_session)?;
    }
    let pane = create_window_with_cwd(default_session, name, Some(cwd), env_vars)?;
    // A pane target also identifies its window for a window-scoped option.
    remember_window(&pane, &option, &pane);
    Ok((default_session.to_string(), pane))
}

fn split_group_window(
    window: &str,
    cwd: &str,
    env_vars: &[(String, String)],
) -> Result<String, String> {
    let env_pairs: Vec<_> = env_vars
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect();
    let mut args = vec![
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        window,
        "-c",
        cwd,
    ];
    for pair in &env_pairs {
        args.extend(["-e", pair]);
    }
    run_capture(&args, "tmux::group_window::split")
}

fn remember_window(target: &str, option: &str, pane: &str) {
    let Some(score) = pane.strip_prefix('%').and_then(|id| id.parse::<u64>().ok()) else {
        return;
    };
    let _ = run_ok(
        &[
            "set-option",
            "-w",
            "-t",
            target,
            option,
            &score.saturating_add(1).to_string(),
        ],
        "tmux::group_window::remember",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        session: &str,
        window: &str,
        pane: &str,
        cwd: &str,
        remembered: &str,
        origin: &str,
    ) -> String {
        [session, window, pane, cwd, remembered, origin].join("\x1e")
    }

    #[test]
    fn selects_newest_matching_pane_across_sessions() {
        let snapshot = [
            row("work", "@1", "%4", "/projects/app", "", ""),
            row("other", "@2", "%10", "/projects/app/.worktrees/fix", "", ""),
            row("other", "@3", "%12", "/projects/apple", "", ""),
            row("other", "@4", "%13", "/elsewhere/app", "", ""),
        ]
        .join("\n");
        let panes = parse_panes(&snapshot);
        assert_eq!(
            select_group_window(&panes, "/projects/app/"),
            Some(("other", "@2"))
        );
    }

    #[test]
    fn remembers_window_after_agent_exits_but_prefers_newer_match() {
        let snapshot = [
            row("work", "@1", "%1", "/tmp", "20", ""),
            row("work", "@2", "%5", "/projects/app", "", ""),
        ]
        .join("\n");
        let panes = parse_panes(&snapshot);
        assert_eq!(
            select_group_window(&panes, "/projects/app"),
            Some(("work", "@1"))
        );
        let snapshot = format!(
            "{snapshot}\n{}",
            row("work", "@3", "%21", "/projects/app", "", "")
        );
        let panes = parse_panes(&snapshot);
        assert_eq!(
            select_group_window(&panes, "/projects/app"),
            Some(("work", "@3"))
        );
    }

    #[test]
    fn follows_viewer_origin_and_ignores_view_sessions() {
        let snapshot = [
            row("work", "@1", "%1", "/tmp", "", ""),
            row(
                "work",
                "@2",
                "%8",
                "/projects/app",
                "",
                "work\t@1\t0\tproject",
            ),
            row("clawtab-view-1", "@3", "%90", "/projects/app", "", ""),
        ]
        .join("\n");
        let panes = parse_panes(&snapshot);
        assert_eq!(
            select_group_window(&panes, "/projects/app"),
            Some(("work", "@1"))
        );
    }

    #[test]
    fn follows_a_pane_moved_out_of_its_remembered_window() {
        let snapshot = [
            row("work", "@1", "%1", "/tmp", "9", ""),
            row("work", "@2", "%8", "/projects/app", "", ""),
        ]
        .join("\n");
        let panes = parse_panes(&snapshot);
        assert_eq!(
            select_group_window(&panes, "/projects/app"),
            Some(("work", "@2"))
        );
    }

    #[test]
    fn missing_origin_or_unrelated_directory_has_no_target() {
        let snapshot = [
            row(
                "work",
                "@2",
                "%8",
                "/projects/app",
                "",
                "work\t@1\t0\tproject",
            ),
            row("elsewhere", "@1", "%3", "/tmp", "", ""),
            "malformed".to_string(),
        ]
        .join("\n");
        let panes = parse_panes(&snapshot);
        assert_eq!(select_group_window(&panes, "/projects/app"), None);
        assert_eq!(select_group_window(&panes, "/projects/unknown"), None);
        assert_eq!(select_group_window(&panes, ""), None);
    }
}
