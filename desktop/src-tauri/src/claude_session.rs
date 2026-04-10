use rusqlite::{Connection, OptionalExtension};
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessProvider {
    Claude,
    Codex,
    Opencode,
}

impl ProcessProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            ProcessProvider::Claude => "claude",
            ProcessProvider::Codex => "codex",
            ProcessProvider::Opencode => "opencode",
        }
    }

    pub fn binary_name(self) -> &'static str {
        self.as_str()
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProcessSnapshot {
    commands: HashMap<String, String>,
    children: HashMap<String, Vec<String>>,
}

impl ProcessSnapshot {
    pub fn capture() -> Self {
        let output = match Command::new("ps")
            .args(["-Ao", "pid=,ppid=,command="])
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
    let provider = detect_process_provider(pane_pid, snapshot);
    resolve_session_info_for_provider(pane_pid, provider, snapshot)
}

pub fn resolve_session_info_for_provider(
    pane_pid: &str,
    provider: Option<ProcessProvider>,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    resolve_session_info_for_provider_with_cwd(pane_pid, provider, snapshot, None)
}

pub fn resolve_session_info_for_provider_with_cwd(
    pane_pid: &str,
    provider: Option<ProcessProvider>,
    snapshot: Option<&ProcessSnapshot>,
    cwd: Option<&str>,
) -> SessionInfo {
    match provider {
        Some(ProcessProvider::Claude) => resolve_claude_session_info(pane_pid, snapshot),
        Some(ProcessProvider::Codex) => resolve_codex_session_info(pane_pid, snapshot),
        Some(ProcessProvider::Opencode) => resolve_opencode_session_info(pane_pid, snapshot, cwd),
        None => SessionInfo::default(),
    }
}

pub fn detect_process_provider(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> Option<ProcessProvider> {
    let owned_snapshot;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    if let Some(provider) = provider_for_command(snapshot.command_for_pid(pane_pid)) {
        return Some(provider);
    }

    for child in snapshot.child_pids(pane_pid) {
        if let Some(provider) = provider_for_command(snapshot.command_for_pid(child)) {
            return Some(provider);
        }

        for grandchild in snapshot.child_pids(child) {
            if let Some(provider) = provider_for_command(snapshot.command_for_pid(grandchild)) {
                return Some(provider);
            }
        }
    }

    None
}

pub fn detect_version_from_command(command: &str) -> Option<String> {
    let mut token = String::new();
    let mut found = Vec::new();

    for ch in command.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            token.push(ch);
        } else if !token.is_empty() {
            found.push(token.clone());
            token.clear();
        }
    }
    if !token.is_empty() {
        found.push(token);
    }

    found.into_iter().find(|item| is_semver(item))
}

fn resolve_claude_session_info(pane_pid: &str, snapshot: Option<&ProcessSnapshot>) -> SessionInfo {
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

    // Only use the exact JSONL for this session; don't fall back to other sessions
    // in the same project dir as that returns wrong queries.

    let (first, last) = read_user_messages(&jsonl_path);
    info.first_query = first;
    info.last_query = last;

    info
}

fn resolve_codex_session_info(pane_pid: &str, snapshot: Option<&ProcessSnapshot>) -> SessionInfo {
    let mut info = SessionInfo::default();

    let codex_pid = if is_codex_process_with_snapshot(pane_pid, snapshot) {
        pane_pid.to_string()
    } else {
        match find_codex_child(pane_pid, snapshot) {
            Some(pid) => pid,
            None => return info,
        }
    };

    let Some(thread_id) = find_codex_thread_id_by_pid(&codex_pid) else {
        return info;
    };

    let Some(thread) = read_codex_thread(&thread_id) else {
        return info;
    };

    info.first_query = normalize_optional_owned(thread.first_user_message);
    info.last_query = read_codex_last_query(&thread.id);

    let started_secs = thread.created_at / 1000;
    info.started_epoch = Some(started_secs as u64);
    info.session_started_at = format_local_timestamp(started_secs);

    if info.first_query.is_none() || info.last_query.is_none() {
        if let Some(rollout_path) = thread.rollout_path {
            let rollout = PathBuf::from(rollout_path);
            let (first, last) = read_codex_rollout_messages(&rollout);
            if info.first_query.is_none() {
                info.first_query = first;
            }
            if info.last_query.is_none() {
                info.last_query = last;
            }
        }
    }

    if info.last_query.is_none() {
        info.last_query = info.first_query.clone();
    } else if info.first_query == info.last_query {
        info.last_query = None;
    }

    info
}

fn resolve_opencode_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
    cwd: Option<&str>,
) -> SessionInfo {
    let mut info = SessionInfo::default();
    let Some(cwd) = cwd.and_then(normalize_optional_str) else {
        return info;
    };

    let prompt = find_opencode_prompt(pane_pid, snapshot);
    let Some(session) = find_opencode_session(&cwd, prompt.as_deref()) else {
        return info;
    };

    let started_secs = session.time_created / 1000;
    info.started_epoch = Some(started_secs as u64);
    info.session_started_at = format_local_timestamp(started_secs);

    let (first, last) = read_opencode_user_messages(&session.id);
    info.first_query = prompt
        .clone()
        .or(first)
        .or_else(|| normalize_optional_owned(session.title.clone()));
    info.last_query = last;

    if info
        .first_query
        .as_deref()
        .is_some_and(|title| title.starts_with("New session - "))
    {
        info.first_query = None;
    }

    if info.last_query.is_none() {
        info.last_query = info.first_query.clone();
    } else if info.first_query == info.last_query {
        info.last_query = None;
    }

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

fn provider_for_command(command: Option<&str>) -> Option<ProcessProvider> {
    let lower = command?.to_ascii_lowercase();
    if lower.contains("codex") {
        Some(ProcessProvider::Codex)
    } else if lower.contains("opencode") {
        Some(ProcessProvider::Opencode)
    } else if lower.contains("claude") && !lower.contains("claude.app") {
        Some(ProcessProvider::Claude)
    } else {
        None
    }
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

fn find_codex_child(parent_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    let owned_snapshot;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    let children = snapshot.child_pids(parent_pid);
    for child_pid in children {
        if is_codex_process_with_snapshot(child_pid, Some(snapshot)) {
            return Some(child_pid.clone());
        }
    }

    for child_pid in children {
        if let Some(pid) = find_codex_child(child_pid, Some(snapshot)) {
            return Some(pid);
        }
    }

    None
}

fn is_codex_process_with_snapshot(pid: &str, snapshot: Option<&ProcessSnapshot>) -> bool {
    match snapshot.and_then(|snap| snap.command_for_pid(pid)) {
        Some(command) => command.to_ascii_lowercase().contains("codex"),
        None => false,
    }
}

fn codex_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".codex")
}

fn latest_codex_sqlite(prefix: &str) -> Option<PathBuf> {
    let dir = codex_dir();
    let entries = fs::read_dir(dir).ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(prefix) && name.ends_with(".sqlite"))
                .unwrap_or(false)
        })
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

fn find_codex_thread_id_by_pid(pid: &str) -> Option<String> {
    let db_path = latest_codex_sqlite("logs_")?;
    let conn = Connection::open(db_path).ok()?;
    conn.query_row(
        "select thread_id from logs
         where process_uuid like ?1 and thread_id is not null
         order by ts desc, ts_nanos desc, id desc
         limit 1",
        [format!("pid:{}:%", pid)],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

struct CodexThreadInfo {
    id: String,
    created_at: i64,
    first_user_message: String,
    rollout_path: Option<String>,
}

#[derive(Clone)]
struct OpencodeSessionInfo {
    id: String,
    title: String,
    time_created: i64,
}

fn read_codex_thread(thread_id: &str) -> Option<CodexThreadInfo> {
    let db_path = latest_codex_sqlite("state_")?;
    let conn = Connection::open(db_path).ok()?;
    conn.query_row(
        "select id, created_at, first_user_message, rollout_path
         from threads where id = ?1 limit 1",
        [thread_id],
        |row| {
            Ok(CodexThreadInfo {
                id: row.get(0)?,
                created_at: row.get(1)?,
                first_user_message: row.get(2)?,
                rollout_path: row.get(3).ok(),
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

fn read_codex_last_query(thread_id: &str) -> Option<String> {
    let path = codex_dir().join("history.jsonl");
    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut last = None;

    for line in reader.lines() {
        let line = line.ok()?;
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if value.get("session_id")?.as_str()? != thread_id {
            continue;
        }
        last = value
            .get("text")
            .and_then(|v| v.as_str())
            .and_then(normalize_optional_str);
    }

    last
}

fn read_codex_rollout_messages(path: &PathBuf) -> (Option<String>, Option<String>) {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return (None, None),
    };
    let reader = std::io::BufReader::new(file);
    let mut first = None;
    let mut last = None;

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let text = value
            .get("payload")
            .and_then(|payload| payload.get("message"))
            .and_then(|message| message.as_str())
            .or_else(|| {
                value
                    .get("payload")
                    .and_then(|payload| payload.get("content"))
                    .and_then(|content| content.as_array())
                    .and_then(|items| {
                        items.iter().find_map(|item| {
                            if item.get("type")?.as_str()? == "input_text" {
                                item.get("text")?.as_str()
                            } else {
                                None
                            }
                        })
                    })
            })
            .and_then(normalize_optional_str);

        if value.get("type").and_then(|v| v.as_str()) == Some("event_msg")
            && value
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(|v| v.as_str())
                == Some("user_message")
        {
            if first.is_none() {
                first = text.clone();
            }
            if text.is_some() {
                last = text;
            }
        } else if value.get("type").and_then(|v| v.as_str()) == Some("response_item")
            && value
                .get("payload")
                .and_then(|payload| payload.get("role"))
                .and_then(|v| v.as_str())
                == Some("user")
        {
            if first.is_none() {
                first = text.clone();
            }
            if text.is_some() {
                last = text;
            }
        }
    }

    if first.is_some() && first == last {
        (first, None)
    } else {
        (first, last)
    }
}

fn opencode_db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".local/share/opencode/opencode.db")
}

fn find_opencode_session(cwd: &str, prompt: Option<&str>) -> Option<OpencodeSessionInfo> {
    let conn = Connection::open(opencode_db_path()).ok()?;
    let mut stmt = conn
        .prepare(
            "select id, title, time_created
             from session
             where ?1 = directory or ?1 like directory || '/%'
             order by length(directory) desc, time_updated desc, time_created desc
             limit 12",
        )
        .ok()?;

    let candidates = stmt
        .query_map([cwd], |row| {
            Ok(OpencodeSessionInfo {
                id: row.get(0)?,
                title: row.get(1)?,
                time_created: row.get(2)?,
            })
        })
        .ok()?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return None;
    }

    let normalized_prompt = prompt.and_then(normalize_prompt_text);
    if let Some(ref prompt_text) = normalized_prompt {
        for candidate in &candidates {
            let (first, _) = read_opencode_user_messages(&candidate.id);
            if first.as_deref().and_then(normalize_prompt_text).as_deref()
                == Some(prompt_text.as_str())
            {
                return Some(candidate.clone());
            }
        }

        for candidate in &candidates {
            if normalize_optional_str(&candidate.title)
                .and_then(|title| normalize_prompt_text(&title))
                .as_deref()
                == Some(prompt_text.as_str())
            {
                return Some(candidate.clone());
            }
        }
    }

    candidates.into_iter().next()
}

fn read_opencode_user_messages(session_id: &str) -> (Option<String>, Option<String>) {
    let conn = match Connection::open(opencode_db_path()) {
        Ok(conn) => conn,
        Err(_) => return (None, None),
    };
    let mut stmt = match conn.prepare(
        "select p.data
         from part p
         join message m on m.id = p.message_id
         where p.session_id = ?1
           and json_extract(m.data, '$.role') = 'user'
           and json_extract(p.data, '$.type') = 'text'
         order by p.time_created asc, p.id asc",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return (None, None),
    };

    let rows = match stmt.query_map([session_id], |row| row.get::<_, String>(0)) {
        Ok(rows) => rows,
        Err(_) => return (None, None),
    };

    let mut first = None;
    let mut last = None;

    for row in rows {
        let Ok(data) = row else {
            continue;
        };
        let text = serde_json::from_str::<serde_json::Value>(&data)
            .ok()
            .and_then(|value| {
                value
                    .get("text")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .and_then(normalize_optional_owned);

        if first.is_none() {
            first = text.clone();
        }
        if text.is_some() {
            last = text;
        }
    }

    if first.is_some() && first == last {
        (first, None)
    } else {
        (first, last)
    }
}

fn normalize_optional_owned(value: String) -> Option<String> {
    normalize_optional_str(value.as_str())
}

fn normalize_optional_str(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn find_opencode_child(parent_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    let owned_snapshot;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    let children = snapshot.child_pids(parent_pid);
    for child_pid in children {
        if is_opencode_process_with_snapshot(child_pid, Some(snapshot)) {
            return Some(child_pid.clone());
        }
    }

    for child_pid in children {
        if let Some(pid) = find_opencode_child(child_pid, Some(snapshot)) {
            return Some(pid);
        }
    }

    None
}

fn is_opencode_process_with_snapshot(pid: &str, snapshot: Option<&ProcessSnapshot>) -> bool {
    match snapshot.and_then(|snap| snap.command_for_pid(pid)) {
        Some(command) => command.to_ascii_lowercase().contains("opencode"),
        None => false,
    }
}

fn find_opencode_prompt(pane_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    let owned_snapshot;
    let snapshot = match snapshot {
        Some(snapshot) => snapshot,
        None => {
            owned_snapshot = ProcessSnapshot::capture();
            &owned_snapshot
        }
    };

    let opencode_pid = if is_opencode_process_with_snapshot(pane_pid, Some(snapshot)) {
        Some(pane_pid.to_string())
    } else {
        find_opencode_child(pane_pid, Some(snapshot))
    }?;

    snapshot
        .command_for_pid(&opencode_pid)
        .and_then(parse_opencode_prompt_from_command)
}

fn parse_opencode_prompt_from_command(command: &str) -> Option<String> {
    let marker = "--prompt ";
    let start = command.find(marker)?;
    let raw = &command[start + marker.len()..];
    normalize_prompt_text(raw)
}

fn normalize_prompt_text(value: &str) -> Option<String> {
    let replaced = value
        .replace("\\012", "\n")
        .replace("\\n", "\n")
        .replace("\\t", "\t");
    normalize_optional_str(&replaced)
}

fn format_local_timestamp(epoch_secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(epoch_secs, 0).map(|dt| {
        dt.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    })
}

fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
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
