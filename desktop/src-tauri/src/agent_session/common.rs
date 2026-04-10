use super::ProcessSnapshot;

pub(super) fn normalize_optional_owned(value: String) -> Option<String> {
    normalize_optional_str(value.as_str())
}

pub(super) fn normalize_optional_str(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) fn normalize_prompt_text(value: &str) -> Option<String> {
    let replaced = value
        .replace("\\012", "\n")
        .replace("\\n", "\n")
        .replace("\\t", "\t");
    normalize_optional_str(&replaced)
}

pub(super) fn format_local_timestamp(epoch_secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(epoch_secs, 0).map(|dt| {
        dt.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    })
}

pub(super) fn find_child_process(
    parent_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
    matches_command: fn(&str) -> bool,
) -> Option<String> {
    let owned_snapshot;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    let children = snapshot.child_pids(parent_pid);
    for child_pid in children {
        if snapshot
            .command_for_pid(child_pid)
            .is_some_and(matches_command)
        {
            return Some(child_pid.clone());
        }
    }

    for child_pid in children {
        if let Some(pid) = find_child_process(child_pid, Some(snapshot), matches_command) {
            return Some(pid);
        }
    }

    None
}

pub(super) fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}
