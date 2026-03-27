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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JsonlMessageContent {
    role: Option<String>,
    content: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SessionInfo {
    pub first_query: Option<String>,
    pub session_started_at: Option<String>,
}

/// Resolve session info for a Claude Code pane.
/// Walks pane_pid children to find the claude process, reads session file,
/// then reads the JSONL to extract the first user message.
pub fn resolve_session_info(pane_pid: &str) -> SessionInfo {
    let mut info = SessionInfo::default();

    // Find claude PID among children of pane_pid
    let claude_pid = match find_claude_child(pane_pid) {
        Some(pid) => pid,
        None => return info,
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
    if let Some(dt) = chrono::DateTime::from_timestamp(started_secs as i64, 0) {
        info.session_started_at = Some(dt.format("%Y-%m-%d %H:%M").to_string());
    }

    // Derive project directory name: /Users/foo/bar -> -Users-foo-bar
    let project_dir = session.cwd.replace('/', "-");
    let jsonl_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude/projects")
        .join(&project_dir)
        .join(format!("{}.jsonl", session.session_id));

    if let Some(query) = read_first_user_message(&jsonl_path) {
        info.first_query = Some(query);
    }

    info
}

/// Find a child process of the given PID that is the claude CLI binary.
fn find_claude_child(parent_pid: &str) -> Option<String> {
    let output = Command::new("pgrep")
        .args(["-P", parent_pid])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let children: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
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

/// Read the first user message from a JSONL conversation file.
fn read_first_user_message(path: &PathBuf) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);

    for line in reader.lines() {
        let line = line.ok()?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let msg: JsonlUserMessage = match serde_json::from_str(line) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if msg.msg_type.as_deref() != Some("user") {
            continue;
        }

        let content = msg.message?.content?;

        let text = match content {
            serde_json::Value::String(s) => s,
            serde_json::Value::Array(arr) => {
                // Find first text block
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

        if !text.is_empty() {
            // Truncate long messages
            let truncated = if text.len() > 200 {
                format!("{}...", &text[..200])
            } else {
                text
            };
            return Some(truncated);
        }
    }

    None
}
