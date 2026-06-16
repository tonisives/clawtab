use super::common::find_child_process;
use super::{ProcessSnapshot, SessionInfo};
use serde::Deserialize;
use std::fs;

pub(super) fn resolve_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    let mut info = SessionInfo::default();

    let agy_pid = if is_agy_process_with_snapshot(pane_pid, snapshot) {
        pane_pid.to_string()
    } else {
        match find_agy_child(pane_pid, snapshot) {
            Some(pid) => pid,
            None => return info,
        }
    };

    let Some(conversation_id) = find_conversation_id_by_pid(&agy_pid) else {
        return info;
    };

    info.session_id = Some(conversation_id.clone());

    let brain_dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".gemini/antigravity-cli/brain")
        .join(&conversation_id);

    let transcript_path = brain_dir.join(".system_generated/logs/transcript.jsonl");

    if let Ok(file) = fs::File::open(&transcript_path) {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(file);
        let mut first_query = None;
        let mut last_query = None;
        let mut started_at = None;

        #[derive(Deserialize)]
        struct TranscriptLine {
            #[serde(rename = "type")]
            msg_type: String,
            content: Option<String>,
            created_at: Option<String>,
        }

        for line in reader.lines().flatten() {
            if let Ok(parsed) = serde_json::from_str::<TranscriptLine>(&line) {
                if parsed.msg_type == "USER_INPUT" {
                    if let Some(mut content) = parsed.content {
                        if content.contains("<USER_REQUEST>") {
                            if let Some(start_idx) = content.find("<USER_REQUEST>\n") {
                                let content_start = start_idx + 15;
                                if let Some(end_idx) = content.find("\n</USER_REQUEST>") {
                                    if end_idx > content_start {
                                        content = content[content_start..end_idx].to_string();
                                    }
                                }
                            }
                        }

                        if first_query.is_none() {
                            first_query = Some(content.clone());
                            started_at = parsed.created_at;
                        } else {
                            last_query = Some(content);
                        }
                    }
                }
            }
        }

        info.first_query = first_query;
        info.last_query = last_query;

        if let Some(started_str) = started_at {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&started_str) {
                let local = dt.with_timezone(&chrono::Local);
                info.started_epoch = Some(local.timestamp() as u64);
                info.session_started_at = Some(local.format("%Y-%m-%d %H:%M").to_string());
            }
        }
    }

    info
}

fn find_agy_child(parent_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    find_child_process(parent_pid, snapshot, is_agy_command)
}

fn is_agy_process_with_snapshot(pid: &str, snapshot: Option<&ProcessSnapshot>) -> bool {
    match snapshot.and_then(|snap| snap.command_for_pid(pid)) {
        Some(command) => is_agy_command(command),
        None => false,
    }
}

fn is_agy_command(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    lower.contains("agy") || lower.contains("antigravity")
}

fn find_conversation_id_by_pid(pid: &str) -> Option<String> {
    let log_dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".gemini/antigravity-cli/log");

    let entries = fs::read_dir(log_dir).ok()?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.starts_with("cli-") && name.ends_with(".log") {
                        if let Ok(modified) = meta.modified() {
                            files.push((modified, entry.path()));
                        }
                    }
                }
            }
        }
    }

    files.sort_by(|a, b| b.0.cmp(&a.0));

    for (_, path) in files {
        if let Ok(file) = fs::File::open(&path) {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(file);
            for line in reader.lines().flatten() {
                let tokens: Vec<&str> = line.split_whitespace().collect();
                if tokens.len() >= 3 {
                    if tokens[2] == pid {
                        if let Some(uuid) = extract_uuid(&line) {
                            return Some(uuid);
                        }
                    }
                }
            }
        }
    }

    None
}

fn extract_uuid(line: &str) -> Option<String> {
    if let Some(idx) = line.find("convID=") {
        let start = idx + 7;
        if line.len() >= start + 36 {
            return Some(line[start..start + 36].to_string());
        }
    }
    if let Some(idx) = line.find("Created conversation ") {
        let start = idx + 21;
        if line.len() >= start + 36 {
            return Some(line[start..start + 36].to_string());
        }
    }
    if let Some(idx) = line.find("Streaming conversation ") {
        let start = idx + 23;
        if line.len() >= start + 36 {
            return Some(line[start..start + 36].to_string());
        }
    }
    if let Some(idx) = line.find("Starting conversation update stream for ") {
        let start = idx + 40;
        if line.len() >= start + 36 {
            return Some(line[start..start + 36].to_string());
        }
    }
    None
}
