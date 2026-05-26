use super::common::{
    find_child_process, format_local_timestamp, normalize_optional_owned, normalize_optional_str,
};
use super::{ProcessSnapshot, SessionInfo};
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

struct CodexThreadInfo {
    id: String,
    created_at: i64,
    first_user_message: String,
    rollout_path: Option<String>,
}

#[derive(Clone)]
struct CachedHistory {
    modified: Option<SystemTime>,
    len: u64,
    last_by_thread_id: HashMap<String, Option<String>>,
}

#[derive(Clone)]
struct CachedRollout {
    modified: Option<SystemTime>,
    len: u64,
    messages_loaded: bool,
    first: Option<String>,
    last: Option<String>,
    token_count: Option<u64>,
}

#[derive(Clone)]
struct CachedSqlitePath {
    checked_at: Instant,
    path: Option<PathBuf>,
}

#[derive(Clone)]
struct CachedThreadId {
    checked_at: Instant,
    thread_id: Option<String>,
}

fn history_cache() -> &'static Mutex<HashMap<PathBuf, CachedHistory>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedHistory>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sqlite_path_cache() -> &'static Mutex<HashMap<String, CachedSqlitePath>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSqlitePath>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn rollout_cache() -> &'static Mutex<HashMap<PathBuf, CachedRollout>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedRollout>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn thread_id_cache() -> &'static Mutex<HashMap<String, CachedThreadId>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedThreadId>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn resolve_session_info(
    pane_pid: &str,
    snapshot: Option<&ProcessSnapshot>,
) -> SessionInfo {
    let mut info = SessionInfo::default();

    let codex_pid = if is_codex_process_with_snapshot(pane_pid, snapshot) {
        pane_pid.to_string()
    } else {
        match find_codex_child(pane_pid, snapshot) {
            Some(pid) => pid,
            None => return info,
        }
    };

    let Some(thread_id) = cached_codex_thread_id_by_pid(&codex_pid) else {
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

    if let Some(rollout_path) = thread.rollout_path.as_deref() {
        let needs_messages = info.first_query.is_none() || info.last_query.is_none();
        let rollout = read_codex_rollout(&PathBuf::from(rollout_path), needs_messages);
        info.token_count = rollout.token_count;
        if info.first_query.is_none() {
            info.first_query = rollout.first;
        }
        if info.last_query.is_none() {
            info.last_query = rollout.last;
        }
    }

    if info.last_query.is_none() {
        info.last_query = info.first_query.clone();
    } else if info.first_query == info.last_query {
        info.last_query = None;
    }

    info
}

fn find_codex_child(parent_pid: &str, snapshot: Option<&ProcessSnapshot>) -> Option<String> {
    find_child_process(parent_pid, snapshot, is_codex_command)
}

fn is_codex_process_with_snapshot(pid: &str, snapshot: Option<&ProcessSnapshot>) -> bool {
    match snapshot.and_then(|snap| snap.command_for_pid(pid)) {
        Some(command) => is_codex_command(command),
        None => false,
    }
}

fn is_codex_command(command: &str) -> bool {
    command.to_ascii_lowercase().contains("codex")
}

fn codex_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".codex")
}

fn latest_codex_sqlite(prefix: &str) -> Option<PathBuf> {
    const SQLITE_PATH_CACHE_TTL: Duration = Duration::from_secs(2);
    {
        let cache = sqlite_path_cache().lock();
        if let Some(cached) = cache.get(prefix) {
            if cached.checked_at.elapsed() < SQLITE_PATH_CACHE_TTL {
                return cached.path.clone();
            }
        }
    }

    let dir = codex_dir();
    let entries = fs::read_dir(dir).ok()?;
    let path = entries
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
        .map(|(_, path)| path);

    {
        let mut cache = sqlite_path_cache().lock();
        cache.insert(
            prefix.to_string(),
            CachedSqlitePath {
                checked_at: Instant::now(),
                path: path.clone(),
            },
        );
    }
    path
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

fn cached_codex_thread_id_by_pid(pid: &str) -> Option<String> {
    const THREAD_ID_HIT_CACHE_TTL: Duration = Duration::from_secs(300);
    const THREAD_ID_MISS_CACHE_TTL: Duration = Duration::from_secs(30);

    let mut cache = thread_id_cache().lock();
    if let Some(cached) = cache.get(pid) {
        let ttl = if cached.thread_id.is_some() {
            THREAD_ID_HIT_CACHE_TTL
        } else {
            THREAD_ID_MISS_CACHE_TTL
        };
        if cached.checked_at.elapsed() < ttl {
            return cached.thread_id.clone();
        }
    }

    let thread_id = find_codex_thread_id_by_pid(pid);
    cache.insert(
        pid.to_string(),
        CachedThreadId {
            checked_at: Instant::now(),
            thread_id: thread_id.clone(),
        },
    );
    thread_id
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
    let metadata = fs::metadata(&path).ok()?;
    let modified = metadata.modified().ok();
    let len = metadata.len();

    {
        let cache = history_cache().lock();
        if let Some(cached) = cache.get(&path) {
            if cached.len == len && cached.modified == modified {
                return cached.last_by_thread_id.get(thread_id).cloned().flatten();
            }
        }
    }

    let file = fs::File::open(path).ok()?;
    let reader = std::io::BufReader::new(file);
    let mut last_by_thread_id: HashMap<String, Option<String>> = HashMap::new();

    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(session_id) = value.get("session_id").and_then(|v| v.as_str()) else {
            continue;
        };
        let text = value
            .get("text")
            .and_then(|v| v.as_str())
            .and_then(normalize_optional_str);
        last_by_thread_id.insert(session_id.to_string(), text);
    }

    let result = last_by_thread_id.get(thread_id).cloned().flatten();
    {
        let mut cache = history_cache().lock();
        cache.insert(
            codex_dir().join("history.jsonl"),
            CachedHistory {
                modified,
                len,
                last_by_thread_id,
            },
        );
    }
    result
}

fn read_codex_rollout(path: &PathBuf, include_messages: bool) -> CachedRollout {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            return CachedRollout {
                modified: None,
                len: 0,
                messages_loaded: include_messages,
                first: None,
                last: None,
                token_count: None,
            }
        }
    };
    let modified = metadata.modified().ok();
    let len = metadata.len();
    let existing = {
        let cache = rollout_cache().lock();
        cache
            .get(path)
            .filter(|cached| cached.len == len && cached.modified == modified)
            .cloned()
    };

    if let Some(cached) = existing.as_ref() {
        if cached.messages_loaded || !include_messages {
            return cached.clone();
        }
    }

    let token_count = if let Some(cached) = existing.as_ref() {
        cached.token_count
    } else {
        read_codex_rollout_token_count(path)
    };

    let (first, last) = if include_messages {
        read_codex_rollout_messages(path)
    } else if let Some(cached) = existing.as_ref() {
        (cached.first.clone(), cached.last.clone())
    } else {
        (None, None)
    };

    let messages_loaded = include_messages
        || existing
            .as_ref()
            .is_some_and(|cached| cached.messages_loaded);
    let cached = CachedRollout {
        modified,
        len,
        messages_loaded,
        first,
        last,
        token_count,
    };
    {
        let mut cache = rollout_cache().lock();
        cache.insert(path.clone(), cached.clone());
    }
    cached
}

fn read_codex_rollout_token_count(path: &PathBuf) -> Option<u64> {
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
            if let Some(count) = extract_codex_token_count(line) {
                return Some(count);
            }
        }

        pos = start;
    }

    None
}

fn extract_codex_token_count(line: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
        return None;
    }

    payload
        .get("info")
        .and_then(|info| info.get("last_token_usage"))
        .and_then(|usage| usage.get("total_tokens"))
        .and_then(|v| v.as_u64())
        .or_else(|| {
            payload
                .get("info")
                .and_then(|info| info.get("total_tokens"))
                .and_then(|v| v.as_u64())
        })
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
