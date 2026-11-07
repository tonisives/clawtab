//! Process completion is not the same as a pane being idle or showing a shell.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneProcessState {
    Running,
    Exited(Option<i32>),
    Missing,
}

/// Preserve the owned pane's exit status and output until its monitor collects them.
pub fn retain_exited_pane(pane_id: &str) -> Result<(), String> {
    let output = super::run(
        &["set-option", "-p", "-t", pane_id, "remain-on-exit", "on"],
        "tmux::retain_exited_pane",
    )
    .map_err(|_| "Unable to configure guarded pane retention".to_string())?;
    if !output.status.success() {
        return Err("Unable to configure guarded pane retention".into());
    }
    Ok(())
}

/// Failed queries are unknown, not exits. Only a successful inventory proves absence.
pub fn pane_process_state(pane_id: &str) -> Result<PaneProcessState, String> {
    let output = super::run(
        &[
            "list-panes",
            "-a",
            "-F",
            "#{pane_id}|#{pane_dead}|#{pane_dead_status}",
        ],
        "tmux::pane_process_state",
    )
    .map_err(|_| "Guarded pane inventory unavailable".to_string())?;
    if !output.status.success() {
        if server_absent(&String::from_utf8_lossy(&output.stderr)) {
            return Ok(PaneProcessState::Missing);
        }
        return Err("Guarded pane inventory unavailable".into());
    }
    parse_state(&String::from_utf8_lossy(&output.stdout), pane_id)
}

// tmux explicitly reports an absent server after a container restart. Other
// failures, including permission and connection errors, still leave state unknown.
fn server_absent(stderr: &str) -> bool {
    stderr.lines().any(|line| {
        line.starts_with("no server running on ")
            || (line.starts_with("error connecting to ")
                && line.ends_with(" (No such file or directory)"))
    })
}

fn parse_state(inventory: &str, pane_id: &str) -> Result<PaneProcessState, String> {
    let mut found = None;
    for line in inventory.lines() {
        let mut fields = line.split('|');
        if fields.next() != Some(pane_id) {
            continue;
        }
        let state = match (fields.next(), fields.next(), fields.next()) {
            (Some("0"), Some(""), None) => PaneProcessState::Running,
            (Some("1"), Some(""), None) => PaneProcessState::Exited(None),
            (Some("1"), Some(code), None) => PaneProcessState::Exited(Some(
                code.parse::<i32>()
                    .ok()
                    .filter(|code| (0..=255).contains(code))
                    .ok_or("Invalid guarded pane exit status")?,
            )),
            _ => return Err("Invalid guarded pane lifecycle metadata".into()),
        };
        // Grouped tmux sessions can list the same pane more than once.
        if found.is_some_and(|previous| previous != state) {
            return Err("Inconsistent guarded pane lifecycle metadata".into());
        }
        found = Some(state);
    }
    Ok(found.unwrap_or(PaneProcessState::Missing))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopped_server_means_sessions_are_gone() {
        assert!(server_absent(
            "no server running on /tmp/tmux-1000/default\n"
        ));
        assert!(server_absent(
            "error connecting to /tmp/tmux-1000/default (No such file or directory)\n"
        ));
        assert!(!server_absent(
            "error connecting to /tmp/tmux-1000/default (Permission denied)"
        ));
        assert!(!server_absent("server exited unexpectedly"));
    }

    #[test]
    fn startup_shell_and_idle_agent_are_alive() {
        assert_eq!(
            parse_state("%17|0|\n", "%17"),
            Ok(PaneProcessState::Running)
        );
    }

    #[test]
    fn preserves_real_success_failure_and_unknown_exit() {
        for (text, code) in [("0", Some(0)), ("7", Some(7)), ("", None)] {
            assert_eq!(
                parse_state(&format!("%17|1|{text}\n"), "%17"),
                Ok(PaneProcessState::Exited(code))
            );
        }
    }

    #[test]
    fn absent_target_is_not_another_panes_exit() {
        assert_eq!(
            parse_state("%170|1|0\n", "%17"),
            Ok(PaneProcessState::Missing)
        );
    }

    #[test]
    fn malformed_or_conflicting_metadata_is_unknown() {
        for inventory in [
            "%17|",
            "%17|2|",
            "%17|1|invalid",
            "%17|1|-1",
            "%17|1|256",
            "%17|0||extra",
            "%17|0|\n%17|1|0",
        ] {
            assert!(parse_state(inventory, "%17").is_err());
        }
    }

    #[test]
    fn grouped_session_duplicates_are_consistent() {
        assert_eq!(
            parse_state("%17|0|\n%17|0|", "%17"),
            Ok(PaneProcessState::Running)
        );
    }
}
