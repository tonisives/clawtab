use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::BufRead;
use std::path::PathBuf;
use std::process::Command;
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

#[derive(Debug, Clone, Serialize, Default)]
pub struct SessionInfo {
    pub first_query: Option<String>,
    pub last_query: Option<String>,
    pub session_started_at: Option<String>,
    pub started_epoch: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct ProcessSnapshot {
    commands: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
}

impl ProcessSnapshot {
    pub fn capture() -> Self {
        let output = match Command::new("ps")
            .args(["-Ao", "pid=,ppid=,comm="])
            .output()
        {
            Ok(o) if o.status.success() => o,
            _ => return Self::default(),
        };

        let mut snapshot = Self::default();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let mut parts = line.split_whitespace();
            let pid = match parts.next() {
                Some(pid) => pid,
                None => continue,
            };
            let ppid = match parts.next() {
                Some(ppid) => ppid,
                None => continue,
            };
            let command = parts.collect::<Vec<_>>().join(" ");
            if command.is_empty() {
                continue;
            }
            snapshot.commands.insert(pid.to_string(), command);
            snapshot
                .children
                .entry(ppid.to_string())
                .or_default()
                .push(pid.to_string());
        }
        snapshot
    }

    pub fn command_for_pid(&self, pid: &str) -> Option<&str> {
        self.commands.get(pid).map(String::as_str)
    }

    pub fn child_pids(&self, pid: &str) -> &[String] {
        self.children.get(pid).map(Vec::as_slice).unwrap_or(&[])
    }
}

#[derive(Clone)]
struct CachedMessages {
    modified: Option<SystemTime>,
    len: u64,
    first: Option<String>,
    last: Option<String>,
}

fn jsonl_cache() -> &'static Mutex<HashMap<PathBuf, CachedMessages>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedMessages>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve session info for a Claude Code pane.
/// Walks pane_pid children to find the claude process, reads session file,
/// then reads the JSONL to extract the first user message.
pub fn resolve_session_info(pane_pid: &str) -> SessionInfo {
    resolve_session_info_with_snapshot(pane_pid, None)
}

pub fn resolve_session_info_with_snapshot(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    let mut info = SessionInfo::default();

    // The pane_pid might be claude itself (e.g. forked sessions), or a shell with claude as child
    let claude_pid = if has_session_file(pane_pid) {
        pane_pid.to_string()
    } else {
        match find_claude_child(pane_pid, snapshot) {
            Some(pid) => pid,
            None => return info,
        }
    };

    // Read session file
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

    // Convert startedAt (epoch ms) to human-readable date
    let started_secs = session.started_at / 1000;
    info.started_epoch = Some(started_secs);
    if let Some(dt) = chrono::DateTime::from_timestamp(started_secs as i64, 0) {
        let local = dt.with_timezone(&chrono::Local);
        info.session_started_at = Some(local.format("%Y-%m-%d %H:%M").to_string());
    }

    // Derive project directory name to match Claude Code's convention:
    // /Users/foo/.bar -> -Users-foo-bar (slashes and tildes become dashes, dots removed)
    let project_dir = session.cwd.replace('/', "-").replace('~', "-").replace('.', "");
    let project_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/projects")
        .join(&project_dir);
    let jsonl_path = project_path.join(format!("{}.jsonl", session.session_id));

    // Only use the exact JSONL for this session; don't fall back to other sessions
    // in the same project dir as that returns wrong queries.

    let (first, last) = read_user_messages(&jsonl_path);
    info.first_query = first;
    info.last_query = last;

    info
}

/// Check if a session file exists for this PID.
fn has_session_file(pid: &str) -> bool {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/sessions")
        .join(format!("{}.json", pid))
        .exists()
}

/// Find a child process of the given PID that is the claude CLI binary.
/// Uses `ps` instead of `pgrep` because macOS pgrep can miss children.
fn find_claude_child(parent_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    let owned_snapshot;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    let children = snapshot.child_pids(parent_pid);

    // Check each child - look for "claude" in the command
    for child_pid in children {
        if is_claude_process_with_snapshot(child_pid, Some(snapshot)) {
            return Some(child_pid.clone());
        }
    }

    // Walk one level deeper (shell -> subshell -> claude)
    for child_pid in children {
        if let Some(pid) = find_claude_child(child_pid, Some(snapshot)) {
            return Some(pid);
        }
    }

    None
}

fn is_claude_process_with_snapshot(pid: &str, snapshot: Option<&ProcessSnapshot>) -> bool {
    if let Some(snapshot) = snapshot {
        if let Some(comm) = snapshot.command_for_pid(pid) {
            return comm.contains("claude") && !comm.contains("Claude.app");
        }
        return false;
    }

    let output = Command::new("ps")
        .args(["-p", pid, "-o", "comm="])
        .output()
        .ok();

    match output {
        Some(o) if o.status.success() => {
            let comm = String::from_utf8_lossy(&o.stdout).trim().to_string();
            comm.contains("claude") && !comm.contains("Claude.app")
        }
        _ => false,
    }
}

/// Read the first and last user messages from a JSONL conversation file.
/// Returns (first_query, last_query). last_query is None if there's only one message.
fn read_user_messages(path: &PathBuf) -> (Option<String>, Option<String>) {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return (None, None),
    };
    let modified = metadata.modified().ok();
    let len = metadata.len();

    if let Ok(cache) = jsonl_cache().lock() {
        if let Some(cached) = cache.get(path) {
            if cached.len == len && cached.modified == modified {
                return (cached.first.clone(), cached.last.clone());
            }
        }
    }

    let first = read_first_user_message(path);
    let last = read_last_user_message(path);
    let last = if first.is_some() && first == last { None } else { last };

    if let Ok(mut cache) = jsonl_cache().lock() {
        cache.insert(
            path.clone(),
            CachedMessages {
                modified,
                len,
                first: first.clone(),
                last: last.clone(),
            },
        );
    }

    (first, last)
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
