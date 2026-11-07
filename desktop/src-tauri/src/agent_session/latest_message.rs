use crate::nfn::types::NfnSource;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

// Read once at completion so saved cards retain that turn's links.
pub(crate) fn latest_agent_message(source: &NfnSource) -> Option<String> {
    let session = source.session_id.as_deref()?;
    if session.is_empty() || session.contains(['/', '\\']) || session == ".." {
        return None;
    }
    let home = dirs::home_dir()?;
    let message = match source.provider.as_deref()? {
        "codex" => read_jsonl(&super::codex::rollout_path(session)?, "codex"),
        "claude" => {
            let cwd = source.cwd.as_deref()?;
            let project = claude_project(cwd);
            read_jsonl(
                &home
                    .join(".claude/projects")
                    .join(project)
                    .join(format!("{session}.jsonl")),
                "claude",
            )
            .or_else(|| {
                let legacy = cwd.replace(['/', '~'], "-").replace('.', "");
                read_jsonl(
                    &home
                        .join(".claude/projects")
                        .join(legacy)
                        .join(format!("{session}.jsonl")),
                    "claude",
                )
            })
        }
        "hermes" => {
            let root = source
                .provider_home
                .as_deref()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(super::hermes::default_home);
            let conn = read_db(&root.join("state.db"))?;
            conn.query_row("SELECT content FROM messages WHERE session_id = ?1 AND role = 'assistant' AND active = 1 AND coalesce(_compressed_summary, 0) = 0 ORDER BY timestamp DESC, id DESC LIMIT 1", [session], |row| row.get::<_, String>(0)).ok()
                .and_then(|content| super::hermes::message_text(&content))
        }
        "opencode" => {
            let conn = read_db(&super::opencode::opencode_db_path())?;
            let mut query = conn.prepare("SELECT json_extract(p.data, '$.text') FROM part p WHERE p.message_id = (SELECT id FROM message WHERE session_id = ?1 AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC, id DESC LIMIT 1) AND json_extract(p.data, '$.type') = 'text' ORDER BY p.time_created, p.id").ok()?;
            let parts = query
                .query_map([session], |row| row.get::<_, String>(0))
                .ok()?;
            Some(parts.filter_map(Result::ok).collect::<Vec<_>>().join("\n"))
        }
        _ => None,
    }?;
    (!message.trim().is_empty() && message.len() <= 64 * 1024).then_some(message)
}

fn claude_project(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn read_db(path: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.busy_timeout(std::time::Duration::from_millis(100))
        .ok()?;
    Some(conn)
}

fn read_jsonl(path: &Path, provider: &str) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    // Large sessions must not require a full transcript scan at completion.
    let offset = file.metadata().ok()?.len().saturating_sub(512 * 1024);
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut reader = BufReader::new(file);
    if offset > 0 {
        let mut partial = String::new();
        reader.read_line(&mut partial).ok()?;
    }
    latest_jsonl(reader.lines().map_while(Result::ok), provider)
}

fn latest_jsonl(lines: impl Iterator<Item = String>, provider: &str) -> Option<String> {
    let mut latest = None;
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if provider == "codex" {
            let payload = &value["payload"];
            match (value["type"].as_str(), payload["type"].as_str()) {
                (Some("event_msg"), Some("user_message" | "task_started")) => latest = None,
                (Some("event_msg"), Some("agent_message")) => {
                    latest = payload["message"].as_str().map(str::to_owned)
                }
                (Some("event_msg"), Some("task_complete")) => {
                    if let Some(message) = payload["last_agent_message"].as_str() {
                        latest = Some(message.into());
                    }
                }
                (Some("response_item"), Some("message")) if payload["role"] == "assistant" => {
                    latest = text_content(&payload["content"])
                }
                _ => {}
            }
        } else {
            match value["type"].as_str() {
                Some("user")
                    if value["message"]["content"].as_array().is_none_or(|parts| {
                        !parts.iter().any(|part| part["type"] == "tool_result")
                    }) =>
                {
                    latest = None
                }
                Some("assistant") => {
                    if let Some(text) = text_content(&value["message"]["content"]) {
                        latest = Some(text);
                    }
                }
                _ => {}
            }
        }
    }
    latest
}

fn text_content(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.into());
    }
    let text = content
        .as_array()?
        .iter()
        .filter(|part| matches!(part["type"].as_str(), Some("text" | "output_text")))
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_project_paths_include_worktrees_and_punctuation() {
        assert_eq!(
            claude_project("/workspace/.worktrees/my_project"),
            "-workspace--worktrees-my-project"
        );
    }

    #[test]
    fn latest_reply_excludes_tools_and_previous_turns() {
        let lines = [
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"Old https://old.test"}}),
            json!({"type":"event_msg","payload":{"type":"task_started"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","output":"https://tool.test"}}),
        ];
        assert_eq!(
            latest_jsonl(lines.iter().map(Value::to_string), "codex"),
            None
        );
        let lines = lines.into_iter().chain([json!({"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"[Preview](https://preview.test)"}})]);
        assert_eq!(
            latest_jsonl(lines.map(|v| v.to_string()), "codex").as_deref(),
            Some("[Preview](https://preview.test)")
        );
    }

    #[test]
    fn claude_reads_text_without_thinking_or_tool_results() {
        let lines = [
            json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"Preview https://preview.test"}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"https://tool.test"}]}}),
        ];
        assert_eq!(
            latest_jsonl(lines.iter().map(Value::to_string), "claude").as_deref(),
            Some("Preview https://preview.test")
        );
    }
}
