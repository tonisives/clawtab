use std::process::Command;

#[derive(Debug, PartialEq)]
struct AgentPane {
    pane_id: String,
    window_id: String,
    pane_pid: String,
    cwd: String,
}

#[derive(Debug, serde::Serialize)]
pub struct AgentIdentity {
    pub pane_id: String,
    pub window_id: String,
    pub pane_pid: String,
    pub provider: super::ProcessProvider,
    pub session_id: Option<String>,
}

fn agent_panes(output: &str) -> Vec<AgentPane> {
    let mut seen = std::collections::HashSet::new();
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(5, '\t');
            let pane_id = fields.next()?;
            let window_id = fields.next()?;
            let pane_pid = fields.next()?;
            let dead = fields.next()?;
            let cwd = fields.next()?;
            if dead == "1" || pane_pid.is_empty() || !seen.insert(pane_id) {
                return None;
            }
            Some(AgentPane {
                pane_id: pane_id.into(),
                window_id: window_id.into(),
                pane_pid: pane_pid.into(),
                cwd: cwd.into(),
            })
        })
        .collect()
}

pub fn agent_identities() -> Result<Vec<AgentIdentity>, String> {
    use super::{self as agent_session, ProcessProvider, ProcessSnapshot};

    let output = Command::new("tmux")
        .args([
            "list-panes",
            "-a",
            "-F",
            "#{pane_id}\t#{window_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_path}",
        ])
        .output()
        .map_err(|error| format!("Could not list tmux panes: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let panes = agent_panes(&String::from_utf8_lossy(&output.stdout));
    let snapshot = ProcessSnapshot::capture();
    // Share process discovery and provider caches across the entire batch.
    std::thread::scope(|scope| {
        let workers: Vec<_> = panes
            .chunks(panes.len().div_ceil(4).max(1))
            .map(|chunk| {
                let snapshot = &snapshot;
                scope.spawn(move || {
                    chunk
                        .iter()
                        .filter_map(|pane| {
                            let provider = agent_session::detect_process_provider(
                                &pane.pane_pid,
                                Some(snapshot),
                            )?;
                            if provider == ProcessProvider::Shell {
                                return None;
                            }
                            let session_id = agent_session::resolve_session_identity(
                                &pane.pane_pid,
                                provider,
                                snapshot,
                                Some(&pane.cwd),
                            );
                            Some(AgentIdentity {
                                pane_id: pane.pane_id.clone(),
                                window_id: pane.window_id.clone(),
                                pane_pid: pane.pane_pid.clone(),
                                provider,
                                session_id,
                            })
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut identities = Vec::new();
        for worker in workers {
            identities.extend(worker.join().map_err(|_| "Agent identity lookup failed")?);
        }
        Ok(identities)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_identity_discovery_skips_dead_panes_and_linked_duplicates() {
        let panes = agent_panes(
            "%1\t@1\t10\t0\t/path with spaces\n\
             %1\t@2\t10\t0\t/path with spaces\n\
             %2\t@3\t20\t1\t/dead\n\
             %3\t@4\t30\t0\t/path\twith tab\n\
             malformed\n",
        );
        assert_eq!(panes.len(), 2);
        assert_eq!(panes[0].pane_id, "%1");
        assert_eq!(panes[0].window_id, "@1");
        assert_eq!(panes[0].pane_pid, "10");
        assert_eq!(panes[0].cwd, "/path with spaces");
        assert_eq!(panes[1].cwd, "/path\twith tab");
    }

    #[test]
    fn batch_identities_contain_only_identity_metadata() {
        let identity = AgentIdentity {
            pane_id: "%1".into(),
            window_id: "@1".into(),
            pane_pid: "10".into(),
            provider: super::super::ProcessProvider::Codex,
            session_id: Some("exact-session".into()),
        };
        assert_eq!(
            serde_json::to_value(identity).unwrap(),
            serde_json::json!({
                "pane_id": "%1", "window_id": "@1", "pane_pid": "10",
                "provider": "codex", "session_id": "exact-session"
            })
        );
    }
}
