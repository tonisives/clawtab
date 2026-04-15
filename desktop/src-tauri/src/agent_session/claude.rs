use super::common::find_child_process;
use super::{ProcessSnapshot, SessionInfo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
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
    first: Option<String>,
    last: Option<String>,
    token_count: Option<u64>,
}

fn jsonl_cache() -> &'static Mutex<HashMap<PathBuf, CachedMessages>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedMessages>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn resolve_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    let mut info = SessionInfo::default();

    // The pane_pid might be claude itself (e.g. forked sessions), or a shell with claude as child.
    let claude_pid = if has_session_file(pane_pid) {
        pane_pid.to_string()
    } else {
        match find_claude_child(pane_pid, snapshot) {
            Some(pid) => pid,
            None => return info,
        }
    };

    let session_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/sessions")
        .join(format!("{}.json", claude_pid));

    let session: SessionFile = match fs::read_to_string(&session_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(s) => s,
        None => return info,
    };

    let started_secs = session.started_at / 1000;
    info.started_epoch = Some(started_secs);
    if let Some(dt) = chrono::DateTime::from_timestamp(started_secs as i64, 0) {
        let local = dt.with_timezone(&chrono::Local);
        info.session_started_at = Some(local.format("%Y-%m-%d %H:%M").to_string());
    }

    // Match Claude Code's project directory convention:
    // /Users/foo/.bar -> -Users-foo-bar.
    let project_dir = session
        .cwd
        .replace('/', "-")
        .replace('~', "-")
        .replace('.', "");
    let project_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/projects")
        .join(&project_dir);
    let jsonl_path = project_path.join(format!("{}.jsonl", session.session_id));

    let (first, last, token_count) = read_session_messages(&jsonl_path);
    info.first_query = first;
    info.last_query = last;
    info.token_count = token_count;

    info
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

fn read_session_messages(path: &PathBuf) -> (Option<String>, Option<String>, Option<u64>) {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return (None, None, None),
    };
    let modified = metadata.modified().ok();
    let len = metadata.len();

    if let Ok(cache) = jsonl_cache().lock() {
        if let Some(cached) = cache.get(path) {
            if cached.len == len && cached.modified == modified {
                return (
                    cached.first.clone(),
                    cached.last.clone(),
                    cached.token_count,
                );
            }
        }
    }

    let first = read_first_user_message(path);
    let last = read_last_user_message(path);
    let token_count = read_latest_token_count(path);
    let last = if first.is_some() && first == last {
        None
    } else {
        last
    };

    if let Ok(mut cache) = jsonl_cache().lock() {
        cache.insert(
            path.clone(),
            CachedMessages {
                modified,
                len,
                first: first.clone(),
                last: last.clone(),
                token_count,
            },
        );
    }

    (first, last, token_count)
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
