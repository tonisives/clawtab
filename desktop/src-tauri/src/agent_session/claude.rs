use super::common::{find_child_process, insert_bounded, SESSION_CACHE_MAX_ENTRIES};
use super::{ProcessSnapshot, SessionInfo};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionFile {
    pid: u32,
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    #[serde(rename = "startedAt")]
    started_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JsonlUserMessage {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    message: Option<JsonlMessageContent>,
    timestamp: Option<String>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JsonlMessageContent {
    role: Option<String>,
    content: Option<serde_json::Value>,
}

#[derive(Clone)]
struct CachedMessages {
    modified: Option<SystemTime>,
    len: u64,
    messages: SessionMessages,
}

#[derive(Clone, Default)]
struct SessionMessages {
    first: Option<String>,
    last: Option<String>,
    token_count: Option<u64>,
    model_id: Option<String>,
    effort: Option<String>,
    title: Option<String>,
}

fn jsonl_cache() -> &'static Mutex<HashMap<PathBuf, CachedMessages>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedMessages>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn live_session(pane_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<SessionFile> {
    // The pane_pid might be claude itself (e.g. forked sessions), or a shell with claude as child.
    let claude_pid = if has_session_file(pane_pid) {
        pane_pid.to_string()
    } else {
        find_claude_child(pane_pid, snapshot)?
    };

    let session_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/sessions")
        .join(format!("{}.json", claude_pid));

    fs::read_to_string(&session_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

pub(super) fn session_id(pane_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    live_session(pane_pid, snapshot).map(|session| session.session_id)
}

pub(super) fn resolve_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    let mut info = SessionInfo::default();
    let Some(session) = live_session(pane_pid, snapshot) else {
        return info;
    };

    info.session_id = Some(session.session_id.clone());

    let started_secs = session.started_at / 1000;
    info.started_epoch = Some(started_secs);
    if let Some(dt) = chrono::DateTime::from_timestamp(started_secs as i64, 0) {
        let local = dt.with_timezone(&chrono::Local);
        info.session_started_at = Some(local.format("%Y-%m-%d %H:%M").to_string());
    }

    let projects = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/projects");
    let Some(jsonl_path) = session_transcript_paths(&projects, &session.cwd, &session.session_id)
        .into_iter()
        .find(|path| path.is_file())
    else {
        return info;
    };

    let messages = read_session_messages(&jsonl_path);
    info.last_user_message_at = super::common::last_user_message_at(&jsonl_path, |value| {
        extract_user_text_from_jsonl_line(&value.to_string()).is_some()
    });
    info.first_query = messages.first;
    info.last_query = messages.last;
    info.token_count = messages.token_count;
    info.model_id = messages.model_id;
    info.agent_effort = messages.effort;
    info.title = messages.title;

    info
}

pub(super) fn session_transcript_paths(
    projects: &std::path::Path,
    cwd: &str,
    session_id: &str,
) -> [PathBuf; 2] {
    let project: String = cwd
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let filename = format!("{session_id}.jsonl");
    let legacy = cwd.replace(['/', '~'], "-").replace('.', "");
    [
        projects.join(project).join(&filename),
        projects.join(legacy).join(filename),
    ]
}

fn has_session_file(pid: &str) -> bool {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/sessions")
        .join(format!("{}.json", pid))
        .exists()
}

fn find_claude_child(parent_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    find_child_process(parent_pid, snapshot, is_claude_command)
}

fn is_claude_command(command: &str) -> bool {
    command.contains("claude") && !command.contains("Claude.app")
}

fn read_session_messages(path: &PathBuf) -> SessionMessages {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return SessionMessages::default(),
    };
    let modified = metadata.modified().ok();
    let len = metadata.len();

    {
        let cache = jsonl_cache().lock();
        if let Some(cached) = cache.get(path) {
            if cached.len == len && cached.modified == modified {
                return cached.messages.clone();
            }
        }
    }

    let first = read_first_user_message(path);
    let last = read_last_user_message(path).filter(|last| first.as_ref() != Some(last));
    let (model_id, effort) = read_latest_selection(path).unzip();
    let messages = SessionMessages {
        first,
        last,
        token_count: read_latest_token_count(path),
        model_id,
        effort: effort.flatten(),
        title: read_session_title(path),
    };

    {
        let mut cache = jsonl_cache().lock();
        insert_bounded(
            &mut cache,
            path.clone(),
            CachedMessages {
                modified,
                len,
                messages: messages.clone(),
            },
            SESSION_CACHE_MAX_ENTRIES,
        );
    }

    messages
}

fn read_session_title(path: &std::path::Path) -> Option<String> {
    let read_title = |kind: &str, field: &str| {
        super::common::read_latest_jsonl(path, |value| {
            if value.get("type")?.as_str()? != kind {
                return None;
            }
            super::common::normalize_optional_str(value.get(field)?.as_str()?)
        })
    };
    read_title("custom-title", "customTitle").or_else(|| read_title("ai-title", "aiTitle"))
}

fn read_first_user_message(path: &PathBuf) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if let Some(text) = extract_user_text_from_jsonl_line(&line) {
            return Some(text);
        }
    }
    None
}

fn read_last_user_message(path: &PathBuf) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }

    let mut pos = len;
    let mut buf = Vec::new();
    const CHUNK_SIZE: u64 = 8192;
    const MAX_TAIL_BYTES: usize = 256 * 1024;

    while pos > 0 && buf.len() < MAX_TAIL_BYTES {
        let start = pos.saturating_sub(CHUNK_SIZE);
        let chunk_len = (pos - start) as usize;
        let mut chunk = vec![0u8; chunk_len];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut chunk).ok()?;
        chunk.extend_from_slice(&buf);
        buf = chunk;

        let text = String::from_utf8_lossy(&buf);
        for line in text.lines().rev() {
            if let Some(message) = extract_user_text_from_jsonl_line(line) {
                return Some(message);
            }
        }

        pos = start;
    }

    None
}

fn read_latest_token_count(path: &PathBuf) -> Option<u64> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }

    let mut pos = len;
    let mut buf = Vec::new();
    const CHUNK_SIZE: u64 = 8192;
    const MAX_TAIL_BYTES: usize = 512 * 1024;

    while pos > 0 && buf.len() < MAX_TAIL_BYTES {
        let start = pos.saturating_sub(CHUNK_SIZE);
        let chunk_len = (pos - start) as usize;
        let mut chunk = vec![0u8; chunk_len];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut chunk).ok()?;
        chunk.extend_from_slice(&buf);
        buf = chunk;

        let text = String::from_utf8_lossy(&buf);
        for line in text.lines().rev() {
            if let Some(count) = extract_token_count_from_jsonl_line(line) {
                return Some(count);
            }
        }

        pos = start;
    }

    None
}

fn extract_token_count_from_jsonl_line(line: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let usage = value
        .get("message")
        .and_then(|message| message.get("usage"))?;

    if let Some(total) = usage.get("total_tokens").and_then(|v| v.as_u64()) {
        return Some(total);
    }

    let input = usage
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_creation = usage
        .get("cache_creation_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let total = input + cache_creation + cache_read + output;
    (total > 0).then_some(total)
}

fn extract_user_text_from_jsonl_line(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let msg: JsonlUserMessage = serde_json::from_str(line).ok()?;
    if msg.msg_type.as_deref() != Some("user") || msg.is_meta == Some(true) {
        return None;
    }

    let content = msg.message.and_then(|m| m.content)?;
    let text = match content {
        serde_json::Value::String(s) => s,
        serde_json::Value::Array(arr) => arr
            .iter()
            .find_map(|item| {
                if item.get("type")?.as_str()? == "text" {
                    item.get("text")?.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
            .unwrap_or_default(),
        _ => return None,
    };

    if text.is_empty() {
        return None;
    }

    let trimmed = text.trim();

    if trimmed.starts_with("<command-name>") {
        if let Some(end) = trimmed.find("</") {
            let inner = trimmed["<command-name>".len()..end].trim().to_string();
            return (!inner.is_empty()).then_some(inner);
        }
        return None;
    }

    if trimmed.starts_with("<command-message>") {
        if let Some(end) = trimmed.find("</") {
            let inner = trimmed["<command-message>".len()..end].trim().to_string();
            return (!inner.is_empty()).then_some(inner);
        }
        return None;
    }

    if trimmed.starts_with('<') && trimmed.contains("command") {
        return None;
    }

    if trimmed.starts_with("This session is being continued from a previous conversation") {
        return None;
    }

    let user_text = if let Some(pos) = trimmed.find("\n<") {
        trimmed[..pos].trim().to_string()
    } else if trimmed.starts_with('<') {
        return None;
    } else {
        text
    };

    (!user_text.is_empty()).then_some(user_text)
}

fn read_latest_selection(path: &std::path::Path) -> Option<(String, Option<String>)> {
    super::common::read_latest_jsonl(path, |value| {
        if value.get("type")?.as_str()? != "assistant" {
            return None;
        }
        let model = value.get("message")?.get("model")?.as_str()?.trim();
        if model.is_empty() || model == "<synthetic>" {
            return None;
        }
        let effort = ["perTurnEffort", "effort"]
            .into_iter()
            .find_map(|key| value.get(key)?.as_str().and_then(super::valid_effort));
        Some((model.to_string(), effort))
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn generated_titles_refresh_and_custom_names_take_priority() {
        use std::io::Write;
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("session.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"user\",\"message\":{\"content\":\"initial prompt\"}}\n",
        )
        .expect("session");
        assert!(super::read_session_messages(&path).title.is_none());
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("file");
        writeln!(
            file,
            "{}",
            r#"{"type":"ai-title","aiTitle":"Generated title"}"#
        )
        .expect("append");
        assert_eq!(
            super::read_session_messages(&path).title.as_deref(),
            Some("Generated title")
        );
        writeln!(
            file,
            "{}",
            r#"{"type":"custom-title","customTitle":"My chosen name"}"#
        )
        .expect("append");
        writeln!(
            file,
            "{}",
            r#"{"type":"ai-title","aiTitle":"New generated title"}"#
        )
        .expect("append");
        assert_eq!(
            super::read_session_messages(&path).title.as_deref(),
            Some("My chosen name")
        );
    }

    #[test]
    fn reads_latest_assistant_model_and_effort_ignoring_synthetic_messages() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"assistant\",\"effort\":\"low\",\"message\":{\"model\":\"claude-old\"}}\n",
                "{\"type\":\"assistant\",\"effort\":\"high\",\"perTurnEffort\":\"xhigh\",\"message\":{\"model\":\"claude-sonnet-5\"}}\n",
                "{\"type\":\"assistant\",\"effort\":\"max\",\"message\":{\"model\":\"<synthetic>\"}}\n",
                "{\"type\":\"user\",\"message\":{\"model\":\"ignore\"}}\n"
            ),
        )
        .expect("session");
        let messages = super::read_session_messages(&path);
        assert_eq!(messages.model_id.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(messages.effort.as_deref(), Some("xhigh"));
        assert_eq!(super::read_session_messages(&path).effort, messages.effort);
    }
}
