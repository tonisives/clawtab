use serde::{Deserialize, Serialize};
use std::fs;
use std::io::BufRead;
use std::path::PathBuf;
use std::process::Command;

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

/// Resolve session info for a Claude Code pane.
/// Walks pane_pid children to find the claude process, reads session file,
/// then reads the JSONL to extract the first user message.
pub fn resolve_session_info(pane_pid: &str) -> SessionInfo {
    let mut info = SessionInfo::default();

    // The pane_pid might be claude itself (e.g. forked sessions), or a shell with claude as child
    let claude_pid = if has_session_file(pane_pid) {
        pane_pid.to_string()
    } else {
        match find_claude_child(pane_pid) {
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

    // If exact JSONL not found (e.g. resumed session), use most recently modified JSONL
    let jsonl_path = if jsonl_path.exists() {
        jsonl_path
    } else {
        find_latest_jsonl(&project_path).unwrap_or(jsonl_path)
    };

    let (first, last) = read_user_messages(&jsonl_path);
    info.first_query = first;
    info.last_query = last;

    info
}

/// Find the most recently modified JSONL file in a project directory.
fn find_latest_jsonl(dir: &PathBuf) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .max_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()))
        .map(|e| e.path())
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
fn find_claude_child(parent_pid: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", "pid=,ppid="])
        .arg("-A")
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let children: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() == 2 && parts[1] == parent_pid {
                Some(parts[0].to_string())
            } else {
                None
            }
        })
        .collect();

    // Check each child - look for "claude" in the command
    for child_pid in &children {
        if is_claude_process(child_pid) {
            return Some(child_pid.clone());
        }
    }

    // Walk one level deeper (shell -> subshell -> claude)
    for child_pid in &children {
        if let Some(pid) = find_claude_child(child_pid) {
            return Some(pid);
        }
    }

    None
}

/// Check if a PID is a claude process by examining its command.
fn is_claude_process(pid: &str) -> bool {
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
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let reader = std::io::BufReader::new(file);

    let mut first: Option<String> = None;
    let mut last: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let msg: JsonlUserMessage = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if msg.msg_type.as_deref() != Some("user") {
            continue;
        }

        if msg.is_meta == Some(true) {
            continue;
        }

        let content = match msg.message.and_then(|m| m.content) {
            Some(c) => c,
            None => continue,
        };

        let text = match content {
            serde_json::Value::String(s) => s,
            serde_json::Value::Array(arr) => {
                arr.iter()
                    .find_map(|item| {
                        if item.get("type")?.as_str()? == "text" {
                            item.get("text")?.as_str().map(|s| s.to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default()
            }
            _ => continue,
        };

        if text.is_empty() {
            continue;
        }

        let trimmed = text.trim();

        // Skip system/command outputs (XML-like tags)
        if trimmed.starts_with('<') && trimmed.contains("command") {
            continue;
        }

        // Skip context continuation messages from /compact
        if trimmed.starts_with("This session is being continued from a previous conversation") {
            continue;
        }

        // Extract user text from messages that mix user text with system tags
        let user_text = if let Some(pos) = trimmed.find("\n<") {
            trimmed[..pos].trim().to_string()
        } else if trimmed.starts_with('<') {
            continue;
        } else {
            text
        };

        if !user_text.is_empty() {
            if first.is_none() {
                first = Some(user_text);
            } else {
                last = Some(user_text);
            }
        }
    }

    (first, last)
}
