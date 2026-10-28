use super::ProcessProvider;

pub(crate) fn session_announcement(line: &[u8]) -> Option<(ProcessProvider, String)> {
    if line.len() > 64 * 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    let (provider, session) = match value["type"].as_str() {
        Some("thread.started") => (ProcessProvider::Codex, value["thread_id"].as_str()?),
        Some("system") if value["subtype"] == "init" => {
            (ProcessProvider::Claude, value["session_id"].as_str()?)
        }
        _ => return None,
    };
    (!session.trim().is_empty() && session.len() <= 256).then(|| (provider, session.into()))
}

pub(crate) fn session_from_output(output: &str) -> Option<(ProcessProvider, String)> {
    output
        .lines()
        .find_map(|line| session_announcement(line.as_bytes()))
}
