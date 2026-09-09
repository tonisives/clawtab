/// Return the first unused ct-<base>-<N> name in the owning session.
pub fn next_ct_window_name(session: &str, base: &str) -> String {
    let existing = super::list_window_names_in_session(session).unwrap_or_default();
    next_name(&existing, base)
}

fn next_name(existing: &[String], base: &str) -> String {
    let base = if base.is_empty() { "pane" } else { base };
    let prefix = format!("ct-{base}-");
    let used: std::collections::HashSet<u32> = existing
        .iter()
        .filter_map(|name| name.strip_prefix(&prefix)?.parse().ok())
        .collect();
    let mut number = 1u32;
    while used.contains(&number) {
        number += 1;
    }
    format!("{prefix}{number}")
}

#[cfg(test)]
mod tests {
    use super::next_name;

    #[test]
    fn agent_names_skip_collisions_and_reuse_gaps() {
        assert_eq!(next_name(&[], "agent"), "ct-agent-1");
        let names = ["ct-agent-1", "ct-agent-3", "ct-errors-2", "ct-agent-old"].map(str::to_string);
        assert_eq!(next_name(&names, "agent"), "ct-agent-2");
        assert_eq!(next_name(&names, ""), "ct-pane-1");
    }
}
