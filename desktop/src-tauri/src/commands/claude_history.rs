use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct HistoryHit {
    pub session_id: String,
    pub project_dir: String,
    pub cwd: String,
    pub first_user_message: String,
    pub match_snippet: Option<String>,
    pub mtime_ms: i64,
}

#[derive(Deserialize)]
struct JsonlEntry {
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default, rename = "isMeta")]
    is_meta: Option<bool>,
    #[serde(default, rename = "type")]
    entry_type: Option<String>,
    #[serde(default)]
    message: Option<MessageField>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum MessageField {
    WithRoleStringContent {
        #[serde(default)]
        role: Option<String>,
        content: String,
    },
    WithRoleArrayContent {
        #[serde(default)]
        role: Option<String>,
        content: Vec<ContentBlock>,
    },
    Other(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(default, rename = "type")]
    block_type: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn extract_text_from_message(msg: &MessageField) -> Option<String> {
    match msg {
        MessageField::WithRoleStringContent { content, .. } => Some(content.clone()),
        MessageField::WithRoleArrayContent { content, .. } => {
            for b in content {
                if b.block_type.as_deref() == Some("text") {
                    if let Some(t) = &b.text {
                        return Some(t.clone());
                    }
                }
            }
            None
        }
        MessageField::Other(_) => None,
    }
}

fn message_role(msg: &MessageField) -> Option<&str> {
    match msg {
        MessageField::WithRoleStringContent { role, .. }
        | MessageField::WithRoleArrayContent { role, .. } => role.as_deref(),
        MessageField::Other(_) => None,
    }
}

fn is_noise_message(s: &str) -> bool {
    let t = s.trim_start();
    t.starts_with("<local-command")
        || t.starts_with("<command-")
        || t.starts_with("<system-reminder")
        || t.starts_with("<!-- Auto-generated")
        || t.starts_with("Unknown command:")
        || t.starts_with("This session is being continued")
}

fn first_user_message(file: &Path) -> (Option<String>, Option<String>) {
    let f = match fs::File::open(file) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let reader = BufReader::new(f);
    let mut cwd: Option<String> = None;
    let mut first_msg: Option<String> = None;
    for line in reader.lines().take(200).flatten() {
        let entry: JsonlEntry = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if cwd.is_none() {
            if let Some(c) = entry.cwd.as_ref() {
                if !c.is_empty() {
                    cwd = Some(c.clone());
                }
            }
        }
        if first_msg.is_some() {
            if cwd.is_some() {
                break;
            }
            continue;
        }
        if entry.is_meta == Some(true) {
            continue;
        }
        if entry.entry_type.as_deref() != Some("user") {
            continue;
        }
        if let Some(m) = &entry.message {
            if message_role(m) != Some("user") {
                continue;
            }
            if let Some(t) = extract_text_from_message(m) {
                let trimmed = t.trim();
                if trimmed.is_empty() || is_noise_message(trimmed) {
                    continue;
                }
                first_msg = Some(truncate(trimmed, 240));
            }
        }
    }
    (cwd, first_msg)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push_str("...");
        out
    }
}

fn decode_project_dir(name: &str) -> String {
    if name.is_empty() {
        return String::new();
    }
    let mut decoded = name.replace('-', "/");
    if !decoded.starts_with('/') {
        decoded.insert(0, '/');
    }
    decoded
}

fn list_session_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let inner = match fs::read_dir(&p) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for f in inner.flatten() {
            let fp = f.path();
            if fp.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                out.push(fp);
            }
        }
    }
    out
}

fn ripgrep_match_files(root: &Path, query: &str) -> Result<HashMap<PathBuf, String>, String> {
    let output = Command::new("rg")
        .arg("--files-with-matches")
        .arg("--max-count=1")
        .arg("--no-messages")
        .arg("--fixed-strings")
        .arg("--ignore-case")
        .arg("--glob")
        .arg("*.jsonl")
        .arg("-e")
        .arg(query)
        .arg(root)
        .output()
        .map_err(|e| format!("ripgrep failed to start: {} (is rg installed?)", e))?;

    let code = output.status.code().unwrap_or(-1);
    if code == 1 {
        return Ok(HashMap::new());
    }
    if code != 0 {
        return Err(format!(
            "rg exited {}: {}",
            code,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut map: HashMap<PathBuf, String> = HashMap::new();
    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let path = PathBuf::from(line);
        let snippet = first_match_snippet(&path, query).unwrap_or_default();
        map.insert(path, snippet);
    }
    Ok(map)
}

fn first_match_snippet(path: &Path, query: &str) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let reader = BufReader::new(f);
    let q = query.to_lowercase();
    for line in reader.lines().flatten() {
        if !line.to_lowercase().contains(&q) {
            continue;
        }
        let entry: JsonlEntry = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if entry.is_meta == Some(true) {
            continue;
        }
        if let Some(m) = &entry.message {
            if let Some(t) = extract_text_from_message(m) {
                let trimmed = t.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let lower = trimmed.to_lowercase();
                if let Some(idx) = lower.find(&q) {
                    let start = idx.saturating_sub(60);
                    let end = (idx + q.len() + 120).min(trimmed.len());
                    let mut snippet = String::new();
                    if start > 0 {
                        snippet.push_str("...");
                    }
                    snippet.push_str(&trimmed[start..end]);
                    if end < trimmed.len() {
                        snippet.push_str("...");
                    }
                    return Some(snippet);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn search_claude_history(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<HistoryHit>, String> {
    let root = projects_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let cap = limit.unwrap_or(100).clamp(1, 500);
    let trimmed = query.trim();

    let (files, snippets): (Vec<PathBuf>, HashMap<PathBuf, String>) = if trimmed.is_empty() {
        (list_session_files(&root), HashMap::new())
    } else {
        let map = ripgrep_match_files(&root, trimmed)?;
        let files = map.keys().cloned().collect();
        (files, map)
    };

    let mut entries: Vec<(PathBuf, i64)> = files
        .into_iter()
        .map(|p| (p.clone(), mtime_ms(&p)))
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut hits: Vec<HistoryHit> = Vec::with_capacity(cap);
    for (path, mtime) in entries {
        if hits.len() >= cap {
            break;
        }
        if is_subagent_path(&path) {
            continue;
        }
        let session_id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if session_id.is_empty() || !seen.insert(session_id.clone()) {
            continue;
        }
        let project_dir = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let (cwd_from_file, first_msg) = first_user_message(&path);
        let cwd = cwd_from_file.unwrap_or_else(|| decode_project_dir(&project_dir));
        let snippet = snippets.get(&path).cloned().filter(|s| !s.is_empty());
        hits.push(HistoryHit {
            session_id,
            project_dir,
            cwd,
            first_user_message: first_msg.unwrap_or_default(),
            match_snippet: snippet,
            mtime_ms: mtime,
        });
    }

    Ok(hits)
}

fn is_subagent_path(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == "subagents")
        || path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.starts_with("agent-"))
            .unwrap_or(false)
}
